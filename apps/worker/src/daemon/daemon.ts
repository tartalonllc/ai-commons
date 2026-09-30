import { createInterface, type Interface } from 'node:readline';
import { isDeepStrictEqual } from 'node:util';
import {
  ConfigError,
  configExists,
  DEFAULT_IDLE_AFTER_MINUTES,
  defaultConfig,
  loadConfig,
  saveConfig as writeConfigFile,
  validateConfig,
  validateProviderEndpoint,
  type ProviderConfig,
  type ScheduleMode,
  type WorkerConfig,
} from '../config.js';
import type { FetchFn } from '../coordinator-client.js';
import { WorkerDatabase } from '../db.js';
import { acquireInstanceLock, type InstanceLock } from '../lock.js';
import { scrubSecrets, type Logger } from '../logger.js';
import type { WorkerPaths } from '../paths.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { WorkerRunner, type RunnerDeps } from '../runner.js';
import { secretAccounts, SecretStoreUnavailableError, type SecretStore } from '../secrets.js';
import { localTotals, type LocalTotals } from '../stats.js';
import {
  DAEMON_MAX_LINE_BYTES,
  parseRequestLine,
  type DaemonErrorCode,
  type DaemonEvent,
  type DaemonResponse,
  type DaemonStatus,
  type ProbeResult,
  type ProviderStatus,
  type ValidRequest,
} from './protocol.js';

const RESUME_MODE_SETTING = 'resume_mode';

export class DaemonError extends Error {
  constructor(
    readonly code: DaemonErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DaemonError';
  }
}

export interface DaemonDeps {
  paths: WorkerPaths;
  secrets: SecretStore;
  registry: ProviderRegistry;
  logger: Logger;
  /** Requests, one JSON object per line (process.stdin in production). */
  input: NodeJS.ReadableStream;
  /** Responses and events (process.stdout). Nothing else may write here. */
  output: NodeJS.WritableStream;
  fetch?: FetchFn;
  now?: () => number;
  statusIntervalMs?: number;
  restartDelayMs?: number;
  runnerOverrides?: Pick<RunnerDeps, 'sleep' | 'retryDelaysMs'>;
  acquireLock?: (dataDir: string) => InstanceLock;
}

function emptyTotals(): LocalTotals {
  return {
    tasks_submitted: 0,
    tasks_failed: 0,
    input_tokens: 0,
    output_tokens: 0,
    local_inference_ms: 0,
    api_cost_usd: 0,
  };
}

/**
 * Serializes one outbound message (without the trailing newline). A line over
 * DAEMON_MAX_LINE_BYTES would be discarded by the shell, leaving a request
 * hanging until it times out, so an oversized response becomes an `internal`
 * error for the same id. An oversized event is dropped: returns undefined.
 */
export function encodeOutbound(message: DaemonResponse | DaemonEvent): string | undefined {
  const line = JSON.stringify(message);
  if (Buffer.byteLength(line, 'utf8') <= DAEMON_MAX_LINE_BYTES) return line;
  if ('event' in message) return undefined;
  const fallback: DaemonResponse = {
    id: message.id,
    ok: false,
    error: { code: 'internal', message: 'Response too large' },
  };
  return JSON.stringify(fallback);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function needsRestart(prev: WorkerConfig, next: WorkerConfig): boolean {
  return (
    prev.coordinator_url !== next.coordinator_url ||
    !isDeepStrictEqual(prev.providers, next.providers)
  );
}

/**
 * The desktop app's view of the worker: a stdio request loop around one
 * WorkerRunner. API keys go straight to the SecretStore and are never echoed,
 * logged or persisted.
 */
export class WorkerDaemon {
  private config: WorkerConfig = defaultConfig();
  private configured = false;
  private db: WorkerDatabase | undefined;
  private lock: InstanceLock | undefined;
  private runner: WorkerRunner | undefined;
  private runLoop: Promise<void> | undefined;
  private intentionalStop = false;
  private idle = false;
  private readonly keys = new Map<string, boolean>();
  private lastError: string | undefined;
  /** Why the existing config file was rejected at startup; cleared by the next save. */
  private configError: string | undefined;
  /** The last lock/DB open failure, so retries log once and clear only their own error. */
  private storageError: string | undefined;
  private lifecycle: Promise<void> = Promise.resolve();
  private configOps: Promise<void> = Promise.resolve();
  private retryTimer: NodeJS.Timeout | undefined;
  private statusTimer: NodeJS.Timeout | undefined;
  private lines: Interface | undefined;
  private stopping = false;
  private closed = false;
  private resolveFinished: () => void = () => undefined;
  private readonly finishedPromise = new Promise<void>((resolve) => {
    this.resolveFinished = resolve;
  });

  constructor(private readonly deps: DaemonDeps) {}

  async start(): Promise<void> {
    const { paths } = this.deps;
    this.openStorage();
    try {
      this.configured = await configExists(paths.configFile);
      this.config = await loadConfig(paths.configFile);
    } catch (error) {
      // Shown as last_error so the UI can say why setup is being asked for again.
      this.configured = false;
      this.configError = this.scrub(error);
      this.deps.logger.warn({ err: this.configError }, 'existing worker config is invalid');
    }
    await this.refreshKeys();

    this.lines = createInterface({ input: this.deps.input, crlfDelay: Infinity });
    this.lines.on('line', (line) => void this.handleLine(line));
    // EOF only ever drains; cancelling the task in flight takes an explicit second request.
    this.lines.on('close', () => void this.drain());
    this.deps.output.on('error', (error: unknown) => {
      this.closed = true; // nothing more can be written
      this.deps.logger.error({ err: this.scrub(error) }, 'daemon output failed; shutting down');
      void this.drain();
    });
    this.statusTimer = setInterval(() => this.emitStatus(), this.deps.statusIntervalMs ?? 5_000);
    this.statusTimer.unref();
    this.emitStatus();
    void this.enqueue(() => this.startRunner());
  }

  finished(): Promise<void> {
    return this.finishedPromise;
  }

  /** Starts a draining shutdown unless one is already under way; never cancels a task. */
  private drain(): Promise<void> {
    return this.stopping ? this.finishedPromise : this.shutdown();
  }

  /** First call drains (finishes the current task); a second call cancels it. */
  async shutdown(): Promise<void> {
    if (this.stopping) {
      this.runner?.requestStop();
      return this.finishedPromise;
    }
    this.stopping = true;
    clearInterval(this.statusTimer);
    clearTimeout(this.retryTimer);
    this.emitStatus();
    await this.enqueue(() => this.stopRunner());
    await this.configOps;
    this.closed = true;
    this.lines?.close();
    this.db?.close();
    this.lock?.release();
    this.resolveFinished();
  }

  status(): DaemonStatus {
    const snap = this.runner?.snapshot();
    const active = this.runner?.activeProviderIds();
    const totals = this.db ? localTotals(this.db, (this.deps.now ?? Date.now)()) : undefined;
    const connection: DaemonStatus['connection'] = !this.db
      ? 'offline'
      : !this.configured
        ? 'unconfigured'
        : (snap?.connection ?? (this.lastError === undefined ? 'connecting' : 'offline'));
    const providers: ProviderStatus[] = this.deps.registry.list().map((reg) => {
      const cfg = this.config.providers.find((p) => p.id === reg.id);
      return {
        id: reg.id,
        kind: reg.kind,
        display_name: reg.displayName,
        enabled: cfg?.enabled ?? false,
        healthy: active === undefined ? null : active.includes(reg.id),
        requires_key: reg.requiresKey,
        has_key: this.keys.get(reg.id) ?? false,
      };
    });
    const status: DaemonStatus = {
      connection,
      coordinator_url: this.config.coordinator_url,
      mode: this.config.schedule.mode,
      idle: this.idle,
      idle_after_minutes: this.config.schedule.idle_after_minutes ?? DEFAULT_IDLE_AFTER_MINUTES,
      today: totals?.today ?? emptyTotals(),
      month: totals?.month ?? emptyTotals(),
      providers,
      limits: { ...this.config.limits.api },
    };
    const workerId = this.runner?.workerId ?? this.config.worker_id;
    if (workerId !== undefined) status.worker_id = workerId;
    if (snap?.current) status.current = snap.current;
    const lastError = snap?.last_error ?? this.lastError ?? this.configError;
    if (lastError !== undefined) status.last_error = lastError;
    return status;
  }

  // ---- requests ----

  private async handleLine(line: string): Promise<void> {
    if (line.trim() === '') return;
    const request = parseRequestLine(line);
    if (!request.ok) {
      this.send({
        id: request.id,
        ok: false,
        error: { code: request.code, message: request.message },
      });
      return;
    }
    // Method names only: params may contain an API key.
    this.deps.logger.debug({ method: request.method }, 'daemon request');
    try {
      const result = await this.dispatch(request);
      this.send({ id: request.id, ok: true, result });
    } catch (error) {
      const code: DaemonErrorCode =
        error instanceof DaemonError
          ? error.code
          : error instanceof ConfigError
            ? 'invalid_config'
            : error instanceof SecretStoreUnavailableError
              ? 'unavailable'
              : 'internal';
      this.send({ id: request.id, ok: false, error: { code, message: this.scrub(error) } });
    }
  }

  private async dispatch(request: ValidRequest): Promise<unknown> {
    switch (request.method) {
      case 'getStatus':
        return this.status();
      case 'getConfig':
        return this.config;
      case 'saveConfig': {
        this.refuseWhileStopping();
        const next = validateConfig(request.params.config);
        // The settings form may not carry worker_id; losing it would force a
        // re-registration. It only means something to the coordinator that issued it.
        let saved = next;
        await this.writeConfig((current) => {
          saved =
            current.worker_id !== undefined &&
            next.worker_id === undefined &&
            next.coordinator_url === current.coordinator_url
              ? { ...next, worker_id: current.worker_id }
              : next;
          return saved;
        });
        return saved;
      }
      case 'setMode':
        this.refuseWhileStopping();
        return { mode: await this.setMode(request.params.mode) };
      case 'resume': {
        this.refuseWhileStopping();
        // Nothing to resume from: report the current mode and write nothing.
        if (this.configured && this.config.schedule.mode !== 'paused') {
          return { mode: this.config.schedule.mode };
        }
        const stored = this.db?.getSetting(RESUME_MODE_SETTING);
        return { mode: await this.setMode(stored === 'idle_only' ? 'idle_only' : 'active') };
      }
      case 'setKey':
        this.refuseWhileStopping();
        await this.setKey(request.params.provider, request.params.key);
        return { stored: true };
      case 'deleteKey':
        this.refuseWhileStopping();
        return { removed: await this.deleteKey(request.params.provider) };
      case 'probeProvider':
        return this.probe(request.params.id, request.params.endpoint);
      case 'setIdle':
        this.idle = request.params.idle;
        this.emitStatus();
        return { idle: this.idle };
      case 'shutdown':
        // Start after the response is written: with no runner to drain, shutdown
        // can mark the daemon closed before this reply would otherwise go out.
        setImmediate(() => void this.shutdown());
        return { stopping: true };
    }
  }

  /**
   * Once shutdown starts, nothing new may reach the config file or keyring, so
   * shutdown's single wait on `configOps` covers every write.
   */
  private refuseWhileStopping(): void {
    if (this.stopping) throw new DaemonError('unavailable', 'The worker is shutting down.');
  }

  /**
   * Config file reads and writes run one at a time, so a runner reload can't
   * leave `this.config` older than a write that finished meanwhile, and
   * concurrent writes don't share saveConfig's temp file.
   */
  private serializeConfig<T>(op: () => Promise<T>): Promise<T> {
    const result = this.configOps.then(op);
    this.configOps = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * `update` receives the latest config. Otherwise the runner persisting its
   * worker_id from the copy it loaded at init could undo a mode change made since.
   */
  private writeConfig(update: (current: WorkerConfig) => WorkerConfig): Promise<void> {
    return this.serializeConfig(async () => {
      const prev = this.config;
      const next = update(prev);
      if (next.schedule.mode === 'paused' && prev.schedule.mode !== 'paused') {
        this.db?.setSetting(RESUME_MODE_SETTING, prev.schedule.mode);
      }
      await writeConfigFile(this.deps.paths.configFile, next);
      const wasConfigured = this.configured;
      this.config = next;
      this.configured = true;
      this.configError = undefined;
      if (!wasConfigured || needsRestart(prev, next)) {
        void this.enqueue(() => this.restartRunner());
      }
      this.emitStatus();
    });
  }

  private async setMode(mode: ScheduleMode): Promise<ScheduleMode> {
    if (!this.configured) {
      throw new DaemonError('bad_request', 'Finish setting up the worker in Settings first.');
    }
    await this.writeConfig((current) => ({
      ...current,
      schedule: { ...current.schedule, mode },
    }));
    return mode;
  }

  private async setKey(provider: string, key: string): Promise<void> {
    if (!this.deps.registry.get(provider)?.requiresKey) {
      throw new DaemonError('bad_request', `Provider "${provider}" does not use an API key`);
    }
    await this.deps.secrets.set(secretAccounts.provider(provider), key);
    this.keys.set(provider, true);
    this.afterKeyChange(provider);
  }

  private async deleteKey(provider: string): Promise<boolean> {
    if (!this.deps.registry.get(provider)?.requiresKey) {
      throw new DaemonError('bad_request', `Provider "${provider}" does not use an API key`);
    }
    const removed = await this.deps.secrets.delete(secretAccounts.provider(provider));
    this.keys.set(provider, false);
    this.afterKeyChange(provider);
    return removed;
  }

  private afterKeyChange(provider: string): void {
    if (this.config.providers.some((p) => p.id === provider && p.enabled)) {
      void this.enqueue(() => this.restartRunner());
    }
    this.emitStatus();
  }

  private async probe(id: string, endpoint: string | undefined): Promise<ProbeResult> {
    const registration = this.deps.registry.get(id);
    if (!registration) throw new DaemonError('bad_request', `Unknown provider "${id}"`);
    if (endpoint !== undefined) {
      // The factory may send the stored API key to this endpoint.
      const requiresTls = registration.requiresKey || registration.kind === 'remote';
      try {
        validateProviderEndpoint(endpoint, requiresTls);
      } catch (error) {
        throw new DaemonError('bad_request', errorMessage(error));
      }
    }
    const existing = this.config.providers.find((p) => p.id === id);
    const endpointToUse = endpoint ?? existing?.endpoint;
    const cfg: ProviderConfig = {
      id,
      kind: registration.kind,
      enabled: true,
      models: existing?.models ?? [],
      ...(endpointToUse === undefined ? {} : { endpoint: endpointToUse }),
      ...(existing?.pricing === undefined ? {} : { pricing: existing.pricing }),
    };
    const known: string[] = [];
    try {
      if (registration.requiresKey) {
        const key = await this.deps.secrets.get(secretAccounts.provider(id));
        if (key !== undefined) known.push(key);
      }
      const provider = await this.deps.registry.create(cfg, this.deps.secrets);
      const health = await provider.healthCheck();
      if (!health.ok) {
        return {
          ok: false,
          message: this.scrub(health.message ?? 'Not reachable', known),
          models: [],
        };
      }
      const models = await provider.getModels();
      return {
        ok: true,
        models: models.map((m) =>
          m.context_window === undefined
            ? { name: m.name }
            : { name: m.name, context_window: m.context_window },
        ),
      };
    } catch (error) {
      return { ok: false, message: this.scrub(error, known), models: [] };
    }
  }

  private async refreshKeys(): Promise<void> {
    for (const registration of this.deps.registry.list()) {
      if (!registration.requiresKey) continue;
      try {
        const key = await this.deps.secrets.get(secretAccounts.provider(registration.id));
        this.keys.set(registration.id, key !== undefined);
      } catch (error) {
        this.keys.set(registration.id, false);
        this.lastError = this.scrub(error);
      }
    }
  }

  // ---- runner lifecycle (always via enqueue) ----

  /** Never rejects: callers `void` it, and shutdown must still close the DB after a failure. */
  private enqueue(op: () => Promise<void>): Promise<void> {
    const next = this.lifecycle.then(op).catch((error: unknown) => {
      this.deps.logger.error({ err: this.scrub(error) }, 'worker lifecycle step failed');
    });
    this.lifecycle = next;
    return next;
  }

  /**
   * Takes the instance lock and opens SQLite. On failure (typically another
   * worker holding the lock) the daemon stays responsive and reports offline;
   * startRunner retries this on the restart timer.
   */
  private openStorage(): boolean {
    if (this.db) return true;
    const { paths, logger } = this.deps;
    try {
      this.lock = (this.deps.acquireLock ?? acquireInstanceLock)(paths.dataDir);
      this.db = new WorkerDatabase(paths.databaseFile);
      // Clear only our own error; anything else (e.g. from refreshKeys) stays visible.
      if (this.storageError !== undefined && this.lastError === this.storageError) {
        this.lastError = undefined;
      }
      this.storageError = undefined;
      return true;
    } catch (error) {
      this.lock?.release();
      this.lock = undefined;
      const message = this.scrub(error);
      if (message !== this.storageError) {
        logger.warn({ err: message }, 'worker daemon cannot contribute yet; will retry');
      }
      this.storageError = message;
      this.lastError = message;
      return false;
    }
  }

  private async startRunner(): Promise<void> {
    if (this.stopping || this.runner) return;
    if (!this.db) {
      if (!this.openStorage()) {
        this.scheduleRetry();
        this.emitStatus();
        return;
      }
      this.emitStatus();
    }
    if (!this.configured || !this.db) return;
    clearTimeout(this.retryTimer);
    this.intentionalStop = false;
    const { paths, secrets, registry, logger } = this.deps;
    const runner = new WorkerRunner({
      db: this.db,
      secrets,
      registry,
      logger,
      loadConfig: () =>
        this.serializeConfig(async () => {
          this.config = await loadConfig(paths.configFile);
          return this.config;
        }),
      // The runner saves only to record its worker_id; keep settings changed since.
      saveConfig: (config) =>
        this.writeConfig((current) =>
          config.worker_id === undefined ? current : { ...current, worker_id: config.worker_id },
        ),
      isIdle: () => this.idle,
      onChange: () => this.emitStatus(),
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      ...this.deps.runnerOverrides,
    });
    this.runner = runner;
    this.lastError = undefined;
    this.emitStatus();
    try {
      await runner.init();
    } catch (error) {
      this.runner = undefined;
      this.lastError = this.scrub(error);
      logger.warn({ err: this.lastError }, 'worker could not start; will retry');
      this.scheduleRetry();
      this.emitStatus();
      return;
    }
    // Shutdown began while init was in flight: never enter the run loop.
    if (this.stopping) {
      this.runner = undefined;
      return;
    }
    this.runLoop = runner
      .run()
      .catch((error: unknown) => {
        this.lastError = this.scrub(error);
        logger.error({ err: this.lastError }, 'worker loop stopped');
      })
      .finally(() => {
        if (this.runner === runner) {
          this.runner = undefined;
          this.runLoop = undefined;
        }
        if (!this.stopping && !this.intentionalStop) this.scheduleRetry();
        this.emitStatus();
      });
    this.emitStatus();
  }

  private async stopRunner(): Promise<void> {
    clearTimeout(this.retryTimer);
    if (!this.runner) return;
    this.intentionalStop = true;
    this.runner.requestStop();
    await this.runLoop;
  }

  private async restartRunner(): Promise<void> {
    await this.stopRunner();
    await this.startRunner();
  }

  private scheduleRetry(): void {
    if (this.stopping) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(
      () => void this.enqueue(() => this.startRunner()),
      this.deps.restartDelayMs ?? 30_000,
    );
    this.retryTimer.unref();
  }

  // ---- output ----

  private emitStatus(): void {
    if (this.closed) return;
    let data: DaemonStatus;
    try {
      data = this.status();
    } catch (error) {
      this.deps.logger.warn({ err: errorMessage(error) }, 'status unavailable');
      return;
    }
    const event: DaemonEvent = { event: 'status', data };
    this.write(event);
  }

  private send(response: DaemonResponse): void {
    if (!this.closed) this.write(response);
  }

  private write(message: DaemonResponse | DaemonEvent): void {
    const line = encodeOutbound(message);
    if (line === undefined) {
      // Only the message kind: the payload itself is never logged.
      this.deps.logger.warn(
        { event: 'event' in message ? message.event : 'response' },
        'dropped an oversized daemon message',
      );
      return;
    }
    this.deps.output.write(`${line}\n`);
  }

  private scrub(error: unknown, knownSecrets: readonly string[] = []): string {
    return scrubSecrets(errorMessage(error), knownSecrets).slice(0, 500);
  }
}
