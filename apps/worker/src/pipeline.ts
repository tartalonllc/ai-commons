import {
  LIMITS,
  PromptRenderError,
  renderPrompt,
  type ExecutionMetrics,
  type FailureReason,
  type JsonObject,
  type LeasedTask,
  type ModelCapability,
  type Project,
  type ResultSubmission,
  type ResultSubmissionStatus,
} from '@ai-commons/protocol';
import {
  ProviderError,
  type AIProvider,
  type InferenceRequest,
  type InferenceResult,
} from '@ai-commons/provider-core';
import { checkInput, checkOutput, checkProjectSchema } from '@ai-commons/validators';
import type { BudgetLimiter } from './budget.js';
import { remoteAllowedFor, type ProviderConfig, type WorkerConfig } from './config.js';
import { CoordinatorError, type CoordinatorClient } from './coordinator-client.js';
import type { WorkerDatabase } from './db.js';
import { scrubSecrets, type Logger } from './logger.js';

export interface ActiveProvider {
  config: ProviderConfig;
  provider: AIProvider;
  /** Models the volunteer allowed that the provider actually offers. */
  models: ModelCapability[];
}

export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

export const abortableSleep: SleepFn = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export const DEFAULT_RETRY_DELAYS_MS = [5_000, 30_000] as const;

export interface ExecutorDeps {
  client: CoordinatorClient;
  db: WorkerDatabase;
  budget: BudgetLimiter;
  logger: Logger;
  workerId: string;
  leaseDurationMs: number;
  config: () => WorkerConfig;
  providers: () => ActiveProvider[];
  /** Delays between attempts; its length + 1 is the attempt count (spec §47). */
  retryDelaysMs?: readonly number[];
  sleep?: SleepFn;
  now?: () => number;
  /** Secrets to scrub from any text that leaves the process or reaches the log. */
  knownSecrets?: () => string[];
}

export type TaskOutcome =
  | { status: 'submitted'; submission: ResultSubmissionStatus; provider: string; model: string }
  | { status: 'failed'; reason: FailureReason; message: string; attempts: number }
  | { status: 'lease_lost'; message: string };

class TaskFailure extends Error {
  constructor(
    readonly reason: FailureReason,
    message: string,
    readonly attempts = 1,
  ) {
    super(message);
  }
}

interface Candidate {
  active: ActiveProvider;
  model: ModelCapability;
}

interface Prepared {
  project: Project;
  system: string;
  user: string;
  maxOutputTokens: number;
  candidates: Candidate[];
}

function providerFailureReason(error: ProviderError): FailureReason {
  switch (error.code) {
    case 'timeout':
      return 'timeout';
    case 'cancelled':
      return 'cancelled';
    case 'invalid_output':
      return 'invalid_output';
    default:
      return 'provider_error';
  }
}

export class TaskExecutor {
  private readonly projects = new Map<string, Project>();
  private readonly retryDelays: readonly number[];
  private readonly sleep: SleepFn;
  private readonly now: () => number;

  constructor(private readonly deps: ExecutorDeps) {
    this.retryDelays = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.sleep = deps.sleep ?? abortableSleep;
    this.now = deps.now ?? Date.now;
  }

  private scrub(text: string): string {
    return scrubSecrets(text, this.deps.knownSecrets?.() ?? []).slice(
      0,
      LIMITS.maxFailureMessageChars,
    );
  }

  async run(task: LeasedTask, signal: AbortSignal): Promise<TaskOutcome> {
    const { db, logger } = this.deps;
    const log = logger.child({ task_id: task.id, project_id: task.project_id });
    const startedAt = this.now();
    db.run(
      `INSERT OR REPLACE INTO tasks (lease_id, task_id, project_id, project_version, status, created_at)
       VALUES (?, ?, ?, ?, 'running', ?)`,
      task.lease_id,
      task.id,
      task.project_id,
      task.project_version,
      startedAt,
    );

    const leaseLost = new AbortController();
    const keeper = this.startLeaseKeeper(task, leaseLost, log);
    const taskSignal = AbortSignal.any([signal, leaseLost.signal]);

    try {
      const prepared = await this.prepare(task);
      const execution = await this.execute(task, prepared, taskSignal, startedAt, log);
      const submission = await this.submit(task, execution, startedAt, taskSignal);
      this.finishTask(task, 'submitted', execution, startedAt, null);
      log.info(
        {
          provider: execution.active.provider.id,
          model: execution.model,
          duration_ms: this.now() - startedAt,
          attempts: execution.attempts,
          submission: submission.status,
        },
        'task completed',
      );
      return {
        status: 'submitted',
        submission: submission.status,
        provider: execution.active.provider.id,
        model: execution.model,
      };
    } catch (error) {
      if (leaseLost.signal.aborted) {
        this.finishTask(task, 'lease_lost', undefined, startedAt, 'lease_lost');
        log.warn('lease lost; abandoning task');
        return { status: 'lease_lost', message: 'lease expired or was revoked' };
      }
      if (
        error instanceof CoordinatorError &&
        (error.code === 'lease_expired' || error.status === 409)
      ) {
        this.finishTask(task, 'lease_lost', undefined, startedAt, 'lease_lost');
        log.warn({ code: error.code }, 'coordinator rejected lease during submission');
        return { status: 'lease_lost', message: this.scrub(error.message) };
      }
      const failure =
        error instanceof TaskFailure
          ? error
          : signal.aborted
            ? new TaskFailure('cancelled', 'worker shutting down')
            : new TaskFailure('other', error instanceof Error ? error.message : 'unexpected error');
      const message = this.scrub(failure.message);
      this.finishTask(task, 'failed', undefined, startedAt, failure.reason);
      log.warn({ reason: failure.reason, attempts: failure.attempts, message }, 'task failed');
      await this.reportFailure(task, failure.reason, message, failure.attempts, log);
      return { status: 'failed', reason: failure.reason, message, attempts: failure.attempts };
    } finally {
      keeper.stop();
    }
  }

  private startLeaseKeeper(task: LeasedTask, lost: AbortController, log: Logger) {
    const interval = Math.max(1_000, Math.floor(this.deps.leaseDurationMs / 3));
    const timer = setInterval(() => {
      this.deps.client
        .extend(task.id, { worker_id: this.deps.workerId, lease_id: task.lease_id })
        .then((res) => log.debug({ expires_at: res.expires_at }, 'lease extended'))
        .catch((error: unknown) => {
          if (
            error instanceof CoordinatorError &&
            (error.code === 'lease_expired' || error.status === 404 || error.status === 409)
          ) {
            lost.abort(new Error('lease lost'));
          } else {
            log.warn(
              { err: error instanceof Error ? error.message : 'unknown' },
              'lease extension failed',
            );
          }
        });
    }, interval);
    timer.unref();
    return { stop: () => clearInterval(timer) };
  }

  private async loadProject(task: LeasedTask): Promise<Project> {
    const cached = this.projects.get(task.project_id);
    if (cached && cached.version === task.project_version) return cached;
    let project: Project;
    try {
      project = await this.deps.client.getProject(task.project_id);
    } catch (error) {
      throw new TaskFailure(
        'other',
        `could not load project definition: ${(error as Error).message}`,
      );
    }
    if (project.id !== task.project_id || project.version !== task.project_version) {
      throw new TaskFailure('other', 'project definition does not match leased task version');
    }
    this.projects.set(project.id, project);
    return project;
  }

  /** Spec §15 steps 1–3 and §43: validate the project, the payload, and local limits. */
  private async prepare(task: LeasedTask): Promise<Prepared> {
    const project = await this.loadProject(task);
    if (project.status !== 'active') throw new TaskFailure('other', 'project is not active');

    for (const [name, schema] of [
      ['input_schema', project.input_schema],
      ['output_schema', project.output_schema],
    ] as const) {
      const issues = checkProjectSchema(schema);
      if (issues.length > 0) {
        throw new TaskFailure('other', `project ${name} rejected: ${issues[0]?.message ?? ''}`);
      }
    }

    const input = checkInput(project.input_schema, task.payload);
    if (!input.ok) {
      throw input.reason === 'too_large'
        ? new TaskFailure('limit_exceeded', 'payload exceeds local size limit')
        : new TaskFailure('other', 'payload does not match project input schema');
    }

    let rendered;
    try {
      rendered = renderPrompt(project.prompt, task.payload);
    } catch (error) {
      if (error instanceof PromptRenderError) throw new TaskFailure('other', error.message);
      throw error;
    }

    const localOnly = project.requirements.local_models_only || task.requirements.local_models_only;
    const minContext = Math.max(
      project.requirements.minimum_context_window,
      task.requirements.minimum_context_window,
    );
    const maxOutputTokens = Math.min(
      project.requirements.max_output_tokens,
      task.requirements.max_output_tokens,
      LIMITS.maxOutputTokens,
    );

    const config = this.deps.config();
    const remoteOk =
      !localOnly && remoteAllowedFor(config, project.id) && config.limits.api.daily_usd > 0;

    const candidates: Candidate[] = [];
    const ordered = [...this.deps.providers()].sort(
      (a, b) => Number(a.provider.kind === 'remote') - Number(b.provider.kind === 'remote'),
    );
    for (const active of ordered) {
      if (!active.config.enabled) continue;
      if (active.provider.kind === 'remote' && !remoteOk) continue;
      const models = active.models
        .filter((m) => m.context_window === undefined || m.context_window >= minContext)
        .sort(
          (a, b) => Number(a.context_window === undefined) - Number(b.context_window === undefined),
        );
      const model = models[0];
      if (model) candidates.push({ active, model });
    }
    if (candidates.length === 0) {
      throw new TaskFailure(
        'other',
        localOnly
          ? 'no local provider satisfies this local-models-only task'
          : 'no enabled provider/model satisfies the task requirements',
      );
    }

    return { project, system: rendered.system, user: rendered.user, maxOutputTokens, candidates };
  }

  private async execute(
    task: LeasedTask,
    prepared: Prepared,
    signal: AbortSignal,
    startedAt: number,
    log: Logger,
  ): Promise<{
    active: ActiveProvider;
    model: string;
    result: InferenceResult;
    attempts: number;
    cost_usd?: number;
  }> {
    const maxAttempts = this.retryDelays.length + 1;
    let candidateIndex = 0;
    let attempts = 0;
    let lastFailure = new TaskFailure('provider_error', 'no attempt made');
    let budgetDenied: string | undefined;

    while (attempts < maxAttempts && candidateIndex < prepared.candidates.length) {
      if (signal.aborted)
        throw new TaskFailure('cancelled', 'task cancelled', Math.max(attempts, 1));
      const remaining = LIMITS.maxTaskRuntimeMs - (this.now() - startedAt);
      if (remaining <= 0)
        throw new TaskFailure('timeout', 'task runtime limit reached', Math.max(attempts, 1));

      const { active, model } = prepared.candidates[candidateIndex] as Candidate;
      const provider = active.provider;
      const request: InferenceRequest = {
        model: model.name,
        system: prepared.system,
        user: prepared.user,
        output_schema: prepared.project.output_schema,
        max_output_tokens: prepared.maxOutputTokens,
        timeout_ms: remaining,
        signal,
      };

      let reservationId: number | undefined;
      if (provider.kind === 'remote') {
        let maxUsd: number;
        try {
          maxUsd = (await provider.estimateCost(request)).max_usd;
        } catch {
          budgetDenied = 'cost estimation failed; refusing to call a paid API without an estimate';
          candidateIndex++;
          continue;
        }
        const reservation = this.deps.budget.reserve({
          provider: provider.id,
          model: model.name,
          taskId: task.id,
          max_usd: maxUsd,
        });
        if (!reservation.ok) {
          budgetDenied = reservation.reason;
          log.info(
            { provider: provider.id, reason: reservation.reason },
            'budget refused remote call',
          );
          candidateIndex++;
          continue;
        }
        reservationId = reservation.reservationId;
      }

      attempts++;
      const attemptStart = this.now();
      try {
        const result = await this.withDeadline(provider.execute(request), remaining, signal);
        const duration = this.now() - attemptStart;
        let cost: number | undefined;
        if (reservationId !== undefined) {
          const reserved = this.deps.budget;
          // Missing cost from a paid provider is charged at the reserved worst case.
          cost = result.cost_usd;
          reserved.settle(reservationId, {
            actual_usd: cost ?? Number.NaN,
            input_tokens: result.input_tokens,
            output_tokens: result.output_tokens,
            duration_ms: duration,
          });
        } else {
          this.deps.budget.recordLocalUsage({
            provider: provider.id,
            model: model.name,
            taskId: task.id,
            input_tokens: result.input_tokens,
            output_tokens: result.output_tokens,
            duration_ms: duration,
          });
        }

        const check = checkOutput(prepared.project.output_schema, result.output);
        if (!check.ok) {
          throw new ProviderError(
            'invalid_output',
            `output failed schema validation at ${check.issues[0]?.path ?? '/'}`,
          );
        }
        return {
          active,
          model: model.name,
          result,
          attempts,
          ...(cost === undefined ? {} : { cost_usd: cost }),
        };
      } catch (error) {
        const perr =
          error instanceof ProviderError
            ? error
            : signal.aborted
              ? new ProviderError('cancelled', 'cancelled')
              : new ProviderError(
                  'unknown',
                  error instanceof Error ? error.message : 'unknown error',
                );

        if (reservationId !== undefined) {
          // Only a definite "not billed" verdict frees the reservation; billed or
          // unknown failures are charged at the reserved worst case. No-op if the
          // call already settled (e.g. output failed schema validation afterwards).
          if (perr.billed === false) this.deps.budget.release(reservationId);
          else this.deps.budget.settle(reservationId, { actual_usd: Number.NaN });
        }

        lastFailure = new TaskFailure(
          providerFailureReason(perr),
          this.scrub(perr.message),
          attempts,
        );
        log.warn(
          { provider: provider.id, model: model.name, code: perr.code, attempt: attempts },
          'attempt failed',
        );
        if (perr.code === 'cancelled' || signal.aborted) {
          throw new TaskFailure('cancelled', 'task cancelled', attempts);
        }
        if (!perr.retryable) {
          candidateIndex++;
          continue;
        }
        if (attempts < maxAttempts) {
          const base = this.retryDelays[attempts - 1] ?? 0;
          const delay = Math.min(Math.max(base, perr.retryAfterMs ?? 0), 60_000);
          try {
            await this.sleep(delay, signal);
          } catch {
            throw new TaskFailure('cancelled', 'task cancelled', attempts);
          }
        }
      }
    }

    if (attempts === 0 && budgetDenied !== undefined) {
      throw new TaskFailure('budget_exceeded', budgetDenied, 1);
    }
    throw new TaskFailure(lastFailure.reason, lastFailure.message, Math.max(attempts, 1));
  }

  private withDeadline<T>(promise: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new ProviderError('timeout', 'provider exceeded task runtime limit')),
        ms,
      );
      const onAbort = () => reject(new ProviderError('cancelled', 'cancelled'));
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (value) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  private async submit(
    task: LeasedTask,
    execution: {
      active: ActiveProvider;
      model: string;
      result: InferenceResult;
      cost_usd?: number;
    },
    startedAt: number,
    signal: AbortSignal,
  ) {
    const { result } = execution;
    const metrics: ExecutionMetrics = {
      duration_ms: Math.min(this.now() - startedAt, LIMITS.maxTaskRuntimeMs),
      ...(result.input_tokens === undefined ? {} : { input_tokens: result.input_tokens }),
      ...(result.output_tokens === undefined ? {} : { output_tokens: result.output_tokens }),
      ...(execution.cost_usd === undefined ? {} : { cost_usd: execution.cost_usd }),
    };
    const body: ResultSubmission = {
      worker_id: this.deps.workerId,
      lease_id: task.lease_id,
      provider: execution.active.provider.id,
      model: execution.model,
      result: result.output as JsonObject,
      metrics,
    };

    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.deps.client.submitResult(task.id, body);
        this.deps.db.run(
          `INSERT OR REPLACE INTO results (lease_id, task_id, result_json, submission_status, submitted_at)
           VALUES (?, ?, ?, ?, ?)`,
          task.lease_id,
          task.id,
          JSON.stringify(result.output),
          response.status,
          this.now(),
        );
        return response;
      } catch (error) {
        const retryable = error instanceof CoordinatorError && error.retryable;
        if (!retryable || attempt >= this.retryDelays.length) throw error;
        await this.sleep(this.retryDelays[attempt] ?? 0, signal);
      }
    }
  }

  private async reportFailure(
    task: LeasedTask,
    reason: FailureReason,
    message: string,
    attempts: number,
    log: Logger,
  ): Promise<void> {
    try {
      await this.deps.client.fail(task.id, {
        worker_id: this.deps.workerId,
        lease_id: task.lease_id,
        reason,
        ...(message ? { message } : {}),
        attempts: Math.min(Math.max(attempts, 1), 10),
      });
    } catch (error) {
      log.warn(
        { err: error instanceof Error ? error.message : 'unknown' },
        'failed to report task failure',
      );
    }
  }

  private finishTask(
    task: LeasedTask,
    status: string,
    execution: { active: ActiveProvider; model: string; attempts: number } | undefined,
    startedAt: number,
    failureReason: string | null,
  ): void {
    this.deps.db.run(
      `UPDATE tasks SET status = ?, attempts = ?, provider = ?, model = ?, failure_reason = ?,
         duration_ms = ?, finished_at = ? WHERE lease_id = ?`,
      status,
      execution?.attempts ?? 0,
      execution?.active.provider.id ?? null,
      execution?.model ?? null,
      failureReason,
      this.now() - startedAt,
      this.now(),
      task.lease_id,
    );
  }
}
