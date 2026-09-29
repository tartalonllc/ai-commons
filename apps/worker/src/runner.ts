import {
  LIMITS,
  PROTOCOL_VERSION,
  type LeaseRequest,
  type Platform,
  type ProviderCapability,
  type WorkerStatus,
} from '@ai-commons/protocol';
import { BudgetLimiter } from './budget.js';
import type { WorkerConfig } from './config.js';
import { CoordinatorClient, CoordinatorError, type FetchFn } from './coordinator-client.js';
import type { WorkerDatabase } from './db.js';
import { scrubSecrets, type Logger } from './logger.js';
import {
  abortableSleep,
  TaskExecutor,
  type ActiveProvider,
  type SleepFn,
  type TaskOutcome,
} from './pipeline.js';
import type { ProviderRegistry } from './providers/registry.js';
import { secretAccounts, type SecretStore } from './secrets.js';

export const CLIENT_VERSION = '0.1.0';
const DEFAULT_CONTEXT_WINDOW = 8_192;
const PAUSED_POLL_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;

export function currentPlatform(): Platform {
  switch (process.platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'macos';
    case 'linux':
      return 'linux';
    default:
      return 'other';
  }
}

export interface Session {
  workerId: string;
  heartbeatIntervalMs: number;
  leaseDurationMs: number;
}

export type ConnectionState = 'connecting' | 'connected' | 'offline';

export interface CurrentTask {
  project_id: string;
  project_name?: string;
  task_id: string;
}

export interface RunnerSnapshot {
  connection: ConnectionState;
  current?: CurrentTask;
  last_error?: string;
}

export interface RunnerDeps {
  db: WorkerDatabase;
  secrets: SecretStore;
  registry: ProviderRegistry;
  logger: Logger;
  /** Re-read on every loop so `aicommons pause` in another terminal takes effect. */
  loadConfig: () => Promise<WorkerConfig>;
  saveConfig?: (config: WorkerConfig) => Promise<void>;
  fetch?: FetchFn;
  sleep?: SleepFn;
  retryDelaysMs?: readonly number[];
  now?: () => number;
  /**
   * Idle source for `idle_only` mode. The desktop app feeds it from OS input idle
   * time. Without one, `idle_only` is refused at init.
   */
  isIdle?: () => boolean;
  /** Called whenever `snapshot()` may have changed (drives desktop status events). */
  onChange?: () => void;
}

export class WorkerRunner {
  private config!: WorkerConfig;
  private client!: CoordinatorClient;
  private session: Session | undefined;
  private secret: string | undefined;
  private providers: ActiveProvider[] = [];
  private providerKeys: string[] = [];
  private executor!: TaskExecutor;
  private budget!: BudgetLimiter;
  private readonly sleep: SleepFn;

  private readonly drain = new AbortController();
  private readonly hardStop = new AbortController();
  private busy = false;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  readonly outcomes: TaskOutcome[] = [];

  private connection: ConnectionState = 'connecting';
  private lastError: string | undefined;
  private currentTask: { project_id: string; task_id: string } | undefined;

  constructor(private readonly deps: RunnerDeps) {
    this.sleep = deps.sleep ?? abortableSleep;
  }

  /** First call: stop leasing, finish the current task. Second call: cancel it. */
  requestStop(): 'draining' | 'aborting' {
    if (!this.drain.signal.aborted) {
      this.drain.abort(new Error('shutdown requested'));
      return 'draining';
    }
    this.hardStop.abort(new Error('forced shutdown'));
    return 'aborting';
  }

  private knownSecrets(): string[] {
    return [...this.providerKeys, ...(this.secret ? [this.secret] : [])];
  }

  async init(): Promise<void> {
    this.config = await this.deps.loadConfig();
    if (this.config.schedule.mode === 'idle_only' && !this.deps.isIdle) {
      throw new Error(
        'Idle-only scheduling needs the desktop app; use "active" or "paused" with the CLI.',
      );
    }
    this.client = new CoordinatorClient({
      baseUrl: this.config.coordinator_url,
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      credentials: () =>
        this.session && this.secret
          ? { workerId: this.session.workerId, secret: this.secret }
          : undefined,
    });
    this.budget = new BudgetLimiter(
      this.deps.db,
      () => this.config.limits.api,
      this.deps.now ?? Date.now,
    );
    const orphaned = this.budget.reconcileStale();
    if (orphaned > 0) this.deps.logger.warn({ orphaned }, 'charged stale budget reservations');

    await this.initProviders();
    await this.ensureRegistered();

    const session = this.session as Session;
    this.executor = new TaskExecutor({
      client: this.client,
      db: this.deps.db,
      budget: this.budget,
      logger: this.deps.logger,
      workerId: session.workerId,
      leaseDurationMs: session.leaseDurationMs,
      config: () => this.config,
      providers: () => this.providers,
      knownSecrets: () => this.knownSecrets(),
      ...(this.deps.retryDelaysMs ? { retryDelaysMs: this.deps.retryDelaysMs } : {}),
      ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
      ...(this.deps.now ? { now: this.deps.now } : {}),
    });
    this.markConnected();
  }

  private async initProviders(): Promise<void> {
    const { registry, secrets, logger, db } = this.deps;
    this.providers = [];
    for (const cfg of this.config.providers) {
      if (!cfg.enabled) continue;
      const registration = registry.get(cfg.id);
      if (registration?.requiresKey) {
        const key = await secrets.get(secretAccounts.provider(cfg.id));
        if (key) this.providerKeys.push(key);
        else {
          logger.warn({ provider: cfg.id }, 'provider enabled but no API key set; skipping');
          continue;
        }
      }
      try {
        const provider = await registry.create(cfg, secrets);
        const health = await provider.healthCheck();
        if (!health.ok) {
          logger.warn(
            { provider: cfg.id, message: health.message },
            'provider unhealthy; skipping',
          );
          continue;
        }
        const offered = await provider.getModels();
        const models =
          provider.kind === 'local'
            ? cfg.models
                .filter((m) => offered.some((o) => o.name === m.name))
                .map((m) => {
                  const o = offered.find((x) => x.name === m.name);
                  const cw = m.context_window ?? o?.context_window;
                  return cw === undefined ? { name: m.name } : { name: m.name, context_window: cw };
                })
            : cfg.models;
        if (models.length === 0) {
          logger.warn({ provider: cfg.id }, 'no allowed models available; skipping');
          continue;
        }
        this.providers.push({ config: cfg, provider, models });
        db.run(
          `INSERT OR REPLACE INTO providers (id, kind, healthy, models, checked_at) VALUES (?, ?, 1, ?, ?)`,
          cfg.id,
          provider.kind,
          JSON.stringify(models),
          Date.now(),
        );
      } catch (error) {
        logger.warn(
          { provider: cfg.id, err: error instanceof Error ? error.message : 'unknown' },
          'provider initialization failed; skipping',
        );
      }
    }
    if (this.providers.length === 0) {
      throw new Error('No usable providers. Run "aicommons configure" and check provider health.');
    }
  }

  private capabilities(): ProviderCapability[] {
    return this.providers.map((p) => ({
      provider: p.provider.id,
      kind: p.provider.kind,
      models: p.models,
    }));
  }

  private async ensureRegistered(): Promise<void> {
    const { db, secrets, logger } = this.deps;
    const row = db.get(
      'SELECT worker_id, heartbeat_interval_ms, lease_duration_ms FROM coordinator_sessions WHERE coordinator_origin = ?',
      this.client.origin,
    );
    if (row) {
      const workerId = String(row.worker_id);
      const secret = await secrets.get(secretAccounts.workerSecret(this.client.origin, workerId));
      if (secret) {
        this.session = {
          workerId,
          heartbeatIntervalMs: Number(row.heartbeat_interval_ms),
          leaseDurationMs: Number(row.lease_duration_ms),
        };
        this.secret = secret;
        try {
          await this.client.updateCapabilities({
            worker_id: workerId,
            capabilities: this.capabilitiesBody(),
          });
        } catch (error) {
          if (error instanceof CoordinatorError && error.code === 'unauthorized') {
            logger.warn('stored worker credentials rejected; re-registering');
            this.session = undefined;
            this.secret = undefined;
          } else {
            logger.debug({ err: (error as Error).message }, 'capability update not accepted');
          }
        }
        if (this.session) return;
      }
    }

    const response = await this.client.register({
      protocol_version: PROTOCOL_VERSION,
      capabilities: this.capabilitiesBody(),
    });
    await secrets.set(
      secretAccounts.workerSecret(this.client.origin, response.worker_id),
      response.worker_secret,
    );
    db.run(
      `INSERT OR REPLACE INTO coordinator_sessions
         (coordinator_origin, worker_id, heartbeat_interval_ms, lease_duration_ms, registered_at)
       VALUES (?, ?, ?, ?, ?)`,
      this.client.origin,
      response.worker_id,
      response.heartbeat_interval_ms,
      response.lease_duration_ms,
      Date.now(),
    );
    this.session = {
      workerId: response.worker_id,
      heartbeatIntervalMs: response.heartbeat_interval_ms,
      leaseDurationMs: Math.min(response.lease_duration_ms, LIMITS.leaseDurationMs * 4),
    };
    this.secret = response.worker_secret;
    if (this.deps.saveConfig && this.config.worker_id !== response.worker_id) {
      this.config = { ...this.config, worker_id: response.worker_id };
      await this.deps.saveConfig(this.config);
    }
    logger.info({ worker_id: response.worker_id }, 'registered with coordinator');
  }

  private capabilitiesBody() {
    return {
      platform: currentPlatform(),
      client_version: CLIENT_VERSION,
      providers: this.capabilities(),
    };
  }

  /** Whether the schedule allows taking new work right now. A running task is never interrupted. */
  private mayLease(): boolean {
    switch (this.config.schedule.mode) {
      case 'active':
        return true;
      case 'idle_only':
        return this.deps.isIdle?.() ?? false;
      case 'paused':
        return false;
    }
  }

  private status(): WorkerStatus {
    if (this.busy) return 'busy';
    return this.mayLease() ? 'available' : 'paused';
  }

  private changed(): void {
    this.deps.onChange?.();
  }

  private markConnected(): void {
    if (this.connection === 'connected' && this.lastError === undefined) return;
    this.connection = 'connected';
    this.lastError = undefined;
    this.changed();
  }

  private markOffline(error: unknown): void {
    this.connection = 'offline';
    const text = error instanceof Error ? error.message : String(error);
    this.lastError = scrubSecrets(text, this.knownSecrets());
    this.changed();
  }

  snapshot(): RunnerSnapshot {
    const snap: RunnerSnapshot = { connection: this.connection };
    if (this.currentTask) {
      const name = this.executor.cachedProject(this.currentTask.project_id)?.name;
      snap.current =
        name === undefined ? { ...this.currentTask } : { ...this.currentTask, project_name: name };
    }
    if (this.lastError !== undefined) snap.last_error = this.lastError;
    return snap;
  }

  /** Providers that passed health checks at init; undefined before init completes. */
  activeProviderIds(): string[] | undefined {
    return this.session ? this.providers.map((p) => p.provider.id) : undefined;
  }

  private async heartbeat(): Promise<void> {
    const session = this.session;
    if (!session) return;
    try {
      await this.client.heartbeat({
        worker_id: session.workerId,
        status: this.status(),
        providers: this.providers.map((p) => p.provider.id),
        current_tasks: this.busy ? 1 : 0,
      });
    } catch (error) {
      this.deps.logger.warn({ err: (error as Error).message }, 'heartbeat failed');
    }
  }

  private leaseRequest(): LeaseRequest {
    const session = this.session as Session;
    const windows = this.providers.flatMap((p) =>
      p.models.map((m) => m.context_window ?? DEFAULT_CONTEXT_WINDOW),
    );
    const categories = this.config.projects.categories;
    return {
      worker_id: session.workerId,
      capabilities: {
        text_generation: true,
        local_inference: this.providers.some((p) => p.provider.kind === 'local'),
        max_context_window: Math.max(DEFAULT_CONTEXT_WINDOW, ...windows),
      },
      ...(categories === 'all' ? {} : { categories }),
    };
  }

  /** Runs until stopped or `maxTasks` tasks have been processed. */
  async run(options: { maxTasks?: number } = {}): Promise<void> {
    if (!this.session) await this.init();
    const session = this.session as Session;
    const { logger } = this.deps;

    await this.heartbeat();
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), session.heartbeatIntervalMs);
    this.heartbeatTimer.unref();

    let backoff = 1_000;
    let processed = 0;
    try {
      while (!this.drain.signal.aborted) {
        if (options.maxTasks !== undefined && processed >= options.maxTasks) break;
        try {
          this.config = await this.deps.loadConfig();
        } catch (error) {
          logger.error(
            { err: (error as Error).message },
            'config reload failed; keeping previous config',
          );
        }
        if (!this.mayLease()) {
          await this.idle(PAUSED_POLL_MS);
          continue;
        }

        let leased;
        try {
          leased = await this.client.lease(this.leaseRequest());
          backoff = 1_000;
          this.markConnected();
        } catch (error) {
          this.markOffline(error);
          const retryAfter = error instanceof CoordinatorError ? error.retryAfterMs : undefined;
          logger.warn({ err: (error as Error).message }, 'lease request failed');
          await this.idle(retryAfter ?? backoff);
          backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
          continue;
        }
        if (!leased.task) {
          await this.idle(leased.retry_after_ms ?? 30_000);
          continue;
        }

        this.busy = true;
        this.currentTask = { project_id: leased.task.project_id, task_id: leased.task.id };
        this.changed();
        try {
          const outcome = await this.executor.run(leased.task, this.hardStop.signal);
          this.outcomes.push(outcome);
        } finally {
          this.busy = false;
          this.currentTask = undefined;
          processed++;
          this.changed();
        }
      }
    } finally {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      await this.heartbeat();
    }
  }

  private async idle(ms: number): Promise<void> {
    try {
      await this.sleep(ms, this.drain.signal);
    } catch {
      // Interrupted by shutdown.
    }
  }

  get workerId(): string | undefined {
    return this.session?.workerId;
  }

  get budgetLimiter(): BudgetLimiter {
    return this.budget;
  }
}
