import {
  PROTOCOL_VERSION,
  type HeartbeatRequest,
  type RegisterWorkerRequest,
  type RegisterWorkerResponse,
  type WorkerCapabilities,
  type WorkerStats,
} from '@ai-commons/protocol';
import { eq, sql } from 'drizzle-orm';
import { hashSecret, safeEqual } from '../auth.js';
import type { CoordinatorConfig } from '../config.js';
import type { Database, Executor } from '../db/client.js';
import { contributions, workerCapabilities, workers } from '../db/schema.js';
import { HttpError } from '../errors.js';
import { newWorkerId, newWorkerSecret } from '../ids.js';

/** 0.x versions are compatible only within the same minor; ≥1.x within the same major. */
export function isCompatibleProtocol(version: string, supported = PROTOCOL_VERSION): boolean {
  const [maj, min] = version.split('.');
  const [smaj, smin] = supported.split('.');
  return maj === smaj && (smaj !== '0' || min === smin);
}

async function replaceCapabilities(
  tx: Executor,
  workerId: string,
  capabilities: WorkerCapabilities,
): Promise<void> {
  const providers = new Set(capabilities.providers.map((p) => p.provider));
  if (providers.size !== capabilities.providers.length) {
    throw new HttpError('bad_request', 'Duplicate provider entries in capabilities');
  }
  await tx.delete(workerCapabilities).where(eq(workerCapabilities.workerId, workerId));
  await tx.insert(workerCapabilities).values(
    capabilities.providers.map((p) => ({
      workerId,
      provider: p.provider,
      kind: p.kind,
      models: p.models,
    })),
  );
}

export async function registerWorker(
  db: Database,
  request: RegisterWorkerRequest,
  config: CoordinatorConfig,
): Promise<RegisterWorkerResponse> {
  if (!isCompatibleProtocol(request.protocol_version)) {
    throw new HttpError(
      'unsupported_protocol_version',
      `Protocol ${request.protocol_version} is not supported (coordinator speaks ${PROTOCOL_VERSION})`,
    );
  }
  const workerId = newWorkerId();
  const secret = newWorkerSecret();
  await db.transaction(async (tx) => {
    await tx.insert(workers).values({
      id: workerId,
      secretHash: hashSecret(secret),
      platform: request.capabilities.platform,
      clientVersion: request.capabilities.client_version,
      protocolVersion: request.protocol_version,
    });
    await replaceCapabilities(tx, workerId, request.capabilities);
    await tx.insert(contributions).values({ workerId });
  });
  return {
    worker_id: workerId,
    worker_secret: secret,
    heartbeat_interval_ms: config.heartbeatIntervalMs,
    lease_duration_ms: config.leaseDurationMs,
  };
}

/**
 * Verifies the bearer secret belongs to the worker named in the request body.
 * Unknown worker and wrong secret produce the same error.
 */
export async function authenticateWorker(
  db: Database,
  workerId: string,
  secret: string,
): Promise<void> {
  const [row] = await db
    .select({ secretHash: workers.secretHash, disabled: workers.disabled })
    .from(workers)
    .where(eq(workers.id, workerId));
  const expected = row?.secretHash ?? hashSecret('\0unknown-worker');
  const valid = safeEqual(hashSecret(secret), expected) && row !== undefined;
  if (!valid) throw new HttpError('unauthorized', 'Invalid worker credentials');
  if (row.disabled) throw new HttpError('forbidden', 'Worker is disabled');
}

export async function updateCapabilities(
  db: Database,
  workerId: string,
  capabilities: WorkerCapabilities,
): Promise<void> {
  await db.transaction(async (tx) => {
    await replaceCapabilities(tx, workerId, capabilities);
    await tx
      .update(workers)
      .set({
        platform: capabilities.platform,
        clientVersion: capabilities.client_version,
        lastSeenAt: sql`now()`,
      })
      .where(eq(workers.id, workerId));
  });
}

export async function recordHeartbeat(db: Database, request: HeartbeatRequest): Promise<string> {
  const [row] = await db
    .update(workers)
    .set({ status: request.status, currentTasks: request.current_tasks, lastSeenAt: sql`now()` })
    .where(eq(workers.id, request.worker_id))
    .returning({ lastSeenAt: workers.lastSeenAt });
  return (row?.lastSeenAt ?? new Date()).toISOString();
}

export async function touchWorker(db: Executor, workerId: string): Promise<void> {
  await db
    .update(workers)
    .set({ lastSeenAt: sql`now()` })
    .where(eq(workers.id, workerId));
}

export const ACU_USD = 0.001;

export async function workerStats(db: Database, workerId: string): Promise<WorkerStats> {
  const [row] = await db.select().from(contributions).where(eq(contributions.workerId, workerId));
  if (!row) throw new HttpError('not_found', 'Worker not found');
  return {
    worker_id: workerId,
    tasks_completed: row.tasksCompleted,
    tasks_validated: row.tasksValidated,
    input_tokens: row.inputTokens,
    output_tokens: row.outputTokens,
    local_inference_ms: row.localInferenceMs,
    total_execution_ms: row.totalExecutionMs,
    api_cost_usd: row.apiCostUsd,
    ai_compute_units: row.apiCostUsd / ACU_USD,
  };
}
