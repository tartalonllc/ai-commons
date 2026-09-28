import {
  LIMITS,
  type ExtendLeaseResponse,
  type LeaseRequest,
  type LeaseResponse,
  type ResultSubmission,
  type ResultSubmissionResponse,
  type TaskFailRequest,
  type TaskStatus,
} from '@ai-commons/protocol';
import { checkOutput, consensusKey, evaluateConsensus, resultHash } from '@ai-commons/validators';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { CoordinatorConfig } from '../config.js';
import type { Database, Executor, Transaction } from '../db/client.js';
import {
  contributions,
  results,
  taskLeases,
  tasks,
  validations,
  workerCapabilities,
} from '../db/schema.js';
import { HttpError } from '../errors.js';
import { newLeaseId, newRowId } from '../ids.js';
import { getProjectRow } from './projects.js';

const NO_TASK_RETRY_MS = 30_000;

const TERMINAL = sql`('COMPLETED', 'FAILED', 'CANCELLED')`;

/** Status after `activeLeasesAfter` active leases remain; terminal states are sticky. */
const nextStatus = (activeLeasesAfter: SQL): SQL =>
  sql`CASE WHEN ${tasks.status} IN ${TERMINAL} THEN ${tasks.status}
           WHEN ${activeLeasesAfter} > 0 THEN 'LEASED' ELSE 'PENDING' END`;

/**
 * Marks overdue leases expired and returns their capacity to the pool. Safe
 * under concurrency: a lease row can only transition out of 'active' once.
 */
export async function reclaimExpiredLeases(tx: Executor): Promise<number> {
  const result = await tx.execute(sql`
    WITH expired AS (
      UPDATE task_leases SET status = 'expired'
      WHERE status = 'active' AND expires_at <= now()
      RETURNING task_id
    ), counts AS (
      SELECT task_id, count(*)::int AS n FROM expired GROUP BY task_id
    )
    UPDATE tasks t
    SET active_leases = t.active_leases - c.n,
        status = CASE WHEN t.status IN ${TERMINAL} THEN t.status
                      WHEN t.active_leases - c.n > 0 THEN 'LEASED' ELSE 'PENDING' END,
        updated_at = now()
    FROM counts c WHERE t.id = c.task_id`);
  return result.rowCount ?? 0;
}

interface CandidateRow extends Record<string, unknown> {
  id: string;
}

export async function leaseTask(
  db: Database,
  request: LeaseRequest,
  config: CoordinatorConfig,
): Promise<LeaseResponse> {
  if (!request.capabilities.text_generation) {
    return { task: null, retry_after_ms: NO_TASK_RETRY_MS };
  }
  const categoryFilter =
    request.categories === undefined
      ? sql`TRUE`
      : sql`p.category IN (${sql.join(
          request.categories.map((c) => sql`${c}`),
          sql`, `,
        )})`;

  return db.transaction(async (tx) => {
    await reclaimExpiredLeases(tx);

    // Coverage counters live on the task row, so if another transaction leases
    // the same row first, Postgres rechecks this predicate on the updated row.
    const candidates = await tx.execute<CandidateRow>(sql`
      SELECT t.id FROM tasks t
      JOIN projects p ON p.id = t.project_id
      WHERE t.status IN ('PENDING', 'LEASED')
        AND p.status = 'active'
        AND t.active_leases + t.completed_replicas < t.replication_factor
        AND (NOT p.local_models_only OR ${request.capabilities.local_inference})
        AND p.minimum_context_window <= ${request.capabilities.max_context_window}
        AND ${categoryFilter}
        AND NOT EXISTS (
          SELECT 1 FROM task_leases l WHERE l.task_id = t.id AND l.worker_id = ${request.worker_id}
        )
      ORDER BY t.priority DESC, t.created_at, t.id
      LIMIT 1
      FOR UPDATE OF t SKIP LOCKED`);

    const taskId = candidates.rows[0]?.id;
    if (taskId === undefined) return { task: null, retry_after_ms: NO_TASK_RETRY_MS };

    const leaseId = newLeaseId();
    const [lease] = await tx
      .insert(taskLeases)
      .values({
        id: leaseId,
        taskId,
        workerId: request.worker_id,
        expiresAt: sql`now() + make_interval(secs => ${config.leaseDurationMs / 1000})`,
      })
      .returning({ expiresAt: taskLeases.expiresAt });
    const [task] = await tx
      .update(tasks)
      .set({
        activeLeases: sql`${tasks.activeLeases} + 1`,
        status: 'LEASED',
        updatedAt: sql`now()`,
      })
      .where(eq(tasks.id, taskId))
      .returning();
    if (!lease || !task) throw new Error('lease insert failed');

    const project = await getProjectRow(tx, task.projectId);
    return {
      task: {
        id: task.id,
        lease_id: leaseId,
        project_id: project.id,
        project_version: project.version,
        payload: task.payload,
        requirements: project.requirements,
        expires_at: lease.expiresAt.toISOString(),
      },
    };
  });
}

interface LockedLease {
  id: string;
  taskId: string;
  workerId: string;
  status: string;
  expired: boolean;
}

/** Locks the lease row and verifies it belongs to this worker and task. */
async function lockLease(
  tx: Transaction,
  leaseId: string,
  workerId: string,
  taskId: string,
): Promise<LockedLease> {
  const rows = await tx.execute<{
    id: string;
    task_id: string;
    worker_id: string;
    status: string;
    expired: boolean;
  }>(sql`
    SELECT id, task_id, worker_id, status, expires_at <= now() AS expired
    FROM task_leases WHERE id = ${leaseId} FOR UPDATE`);
  const row = rows.rows[0];
  if (!row || row.task_id !== taskId)
    throw new HttpError('not_found', 'Lease not found for this task');
  if (row.worker_id !== workerId)
    throw new HttpError('forbidden', 'Lease belongs to another worker');
  return {
    id: row.id,
    taskId: row.task_id,
    workerId: row.worker_id,
    status: row.status,
    expired: row.expired,
  };
}

function assertLeaseActive(lease: LockedLease): void {
  if (lease.status !== 'active' || lease.expired) {
    throw new HttpError(
      'lease_expired',
      `Lease is no longer active (${lease.expired ? 'expired' : lease.status})`,
    );
  }
}

/** Ends an active lease: returns capacity, optionally counting a completed replica. */
async function endLease(
  tx: Transaction,
  lease: LockedLease,
  leaseStatus: 'completed' | 'rejected' | 'failed',
  extraTaskUpdates: Partial<Record<'failureCount', SQL>> = {},
): Promise<void> {
  await tx.update(taskLeases).set({ status: leaseStatus }).where(eq(taskLeases.id, lease.id));
  await tx
    .update(tasks)
    .set({
      activeLeases: sql`${tasks.activeLeases} - 1`,
      completedReplicas:
        leaseStatus === 'completed'
          ? sql`${tasks.completedReplicas} + 1`
          : sql`${tasks.completedReplicas}`,
      status: nextStatus(sql`${tasks.activeLeases} - 1`),
      updatedAt: sql`now()`,
      ...extraTaskUpdates,
    })
    .where(eq(tasks.id, lease.taskId));
}

export async function extendLease(
  db: Database,
  taskId: string,
  workerId: string,
  leaseId: string,
  config: CoordinatorConfig,
): Promise<ExtendLeaseResponse> {
  return db.transaction(async (tx) => {
    const lease = await lockLease(tx, leaseId, workerId, taskId);
    assertLeaseActive(lease);
    const [row] = await tx
      .update(taskLeases)
      .set({ expiresAt: sql`now() + make_interval(secs => ${config.leaseDurationMs / 1000})` })
      .where(eq(taskLeases.id, leaseId))
      .returning({ expiresAt: taskLeases.expiresAt });
    if (!row) throw new HttpError('not_found', 'Lease not found');
    return { lease_id: leaseId, expires_at: row.expiresAt.toISOString() };
  });
}

async function creditValidated(tx: Transaction, workerIds: string[]): Promise<void> {
  for (const workerId of workerIds) {
    await tx
      .update(contributions)
      .set({ tasksValidated: sql`${contributions.tasksValidated} + 1`, updatedAt: sql`now()` })
      .where(eq(contributions.workerId, workerId));
  }
}

async function recordValidation(
  tx: Transaction,
  taskId: string,
  workerId: string | null,
  outcome: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await tx.insert(validations).values({ id: newRowId('val'), taskId, workerId, outcome, detail });
}

export interface SubmitOutcome {
  response: ResultSubmissionResponse;
  taskStatus: TaskStatus;
}

export async function submitResult(
  db: Database,
  taskId: string,
  submission: ResultSubmission,
): Promise<SubmitOutcome> {
  return db.transaction(async (tx) => {
    const lease = await lockLease(tx, submission.lease_id, submission.worker_id, taskId);

    const [existing] = await tx
      .select({ id: results.id })
      .from(results)
      .where(and(eq(results.taskId, taskId), eq(results.workerId, submission.worker_id)));
    const [taskRow] = await tx
      .execute<{ status: string }>(sql`SELECT status FROM tasks WHERE id = ${taskId} FOR UPDATE`)
      .then((r) => r.rows);
    if (existing) {
      return {
        response: { status: 'duplicate' },
        taskStatus: (taskRow?.status ?? 'PENDING') as TaskStatus,
      };
    }
    assertLeaseActive(lease);

    const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId));
    if (!task) throw new HttpError('not_found', 'Task not found');
    const project = await getProjectRow(tx, task.projectId);

    const check = checkOutput(project.outputSchema, submission.result);
    if (!check.ok) {
      await endLease(tx, lease, 'rejected');
      const reason = check.issues
        .slice(0, 3)
        .map((i) => `${i.path}: ${i.message}`)
        .join('; ');
      await recordValidation(tx, taskId, submission.worker_id, 'rejected_output', {
        issues: check.issues,
      });
      const [after] = await tx
        .select({ status: tasks.status })
        .from(tasks)
        .where(eq(tasks.id, taskId));
      return {
        response: {
          status: 'rejected',
          reason: `Result does not match output_schema: ${reason}`.slice(0, 500),
        },
        taskStatus: (after?.status ?? 'PENDING') as TaskStatus,
      };
    }

    const resultId = newRowId('res');
    await tx.insert(results).values({
      id: resultId,
      taskId,
      workerId: submission.worker_id,
      leaseId: lease.id,
      provider: submission.provider,
      model: submission.model,
      result: submission.result,
      resultHash: resultHash(taskId, submission.result, submission.worker_id),
      inputTokens: submission.metrics.input_tokens ?? null,
      outputTokens: submission.metrics.output_tokens ?? null,
      durationMs: submission.metrics.duration_ms,
      costUsd: submission.metrics.cost_usd ?? null,
    });
    await endLease(tx, lease, 'completed');

    const [capability] = await tx
      .select({ kind: workerCapabilities.kind })
      .from(workerCapabilities)
      .where(
        and(
          eq(workerCapabilities.workerId, submission.worker_id),
          eq(workerCapabilities.provider, submission.provider),
        ),
      );
    const isLocal = capability?.kind === 'local';
    const m = submission.metrics;
    await tx
      .update(contributions)
      .set({
        tasksCompleted: sql`${contributions.tasksCompleted} + 1`,
        inputTokens: sql`${contributions.inputTokens} + ${m.input_tokens ?? 0}`,
        outputTokens: sql`${contributions.outputTokens} + ${m.output_tokens ?? 0}`,
        totalExecutionMs: sql`${contributions.totalExecutionMs} + ${m.duration_ms}`,
        localInferenceMs: sql`${contributions.localInferenceMs} + ${isLocal ? m.duration_ms : 0}`,
        // Only remote providers can donate API spend; local results never carry cost credit.
        apiCostUsd: sql`${contributions.apiCostUsd} + ${isLocal ? 0 : (m.cost_usd ?? 0)}`,
        updatedAt: sql`now()`,
      })
      .where(eq(contributions.workerId, submission.worker_id));

    const status = await applyValidation(tx, task, project, submission, resultId);
    return { response: { status: 'accepted' }, taskStatus: status };
  });
}

type TaskRow = typeof tasks.$inferSelect;
type ProjectRow = Awaited<ReturnType<typeof getProjectRow>>;

async function applyValidation(
  tx: Transaction,
  task: TaskRow,
  project: ProjectRow,
  submission: ResultSubmission,
  resultId: string,
): Promise<TaskStatus> {
  const workerId = submission.worker_id;
  const fields = project.validation.consensus_fields ?? [];

  if (task.status === 'FAILED' || task.status === 'CANCELLED') return task.status;

  if (task.status === 'COMPLETED') {
    // Late replica for an already-decided task: credit agreement, never change the outcome.
    const agrees =
      project.validation.mode !== 'consensus' ||
      (task.consensusKey !== null && consensusKey(submission.result, fields) === task.consensusKey);
    if (agrees) await creditValidated(tx, [workerId]);
    return 'COMPLETED';
  }

  if (project.validation.mode !== 'consensus') {
    // 'schema' (and, until implemented, 'deterministic'): a schema-valid result completes the task.
    await tx
      .update(tasks)
      .set({
        status: 'COMPLETED',
        acceptedResultId: resultId,
        completedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(tasks.id, task.id));
    await creditValidated(tx, [workerId]);
    await recordValidation(tx, task.id, workerId, 'accepted', { mode: project.validation.mode });
    return 'COMPLETED';
  }

  const candidates = await tx
    .select({ id: results.id, worker_id: results.workerId, result: results.result })
    .from(results)
    .where(eq(results.taskId, task.id))
    .orderBy(results.createdAt, results.id);
  const outcome = evaluateConsensus(
    candidates,
    fields,
    task.replicationFactor,
    LIMITS.maxReplicationFactor,
  );

  switch (outcome.status) {
    case 'accepted': {
      const accepted = candidates.find((c) => c.worker_id === outcome.agreeing[0]);
      await tx
        .update(tasks)
        .set({
          status: 'COMPLETED',
          consensusKey: outcome.key,
          acceptedResultId: accepted?.id ?? resultId,
          completedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(tasks.id, task.id));
      await creditValidated(tx, outcome.agreeing);
      await recordValidation(tx, task.id, null, 'accepted', {
        agreeing: outcome.agreeing,
        dissenting: outcome.dissenting,
      });
      return 'COMPLETED';
    }
    case 'pending': {
      if (outcome.needed_replicas > task.replicationFactor) {
        await tx
          .update(tasks)
          .set({ replicationFactor: outcome.needed_replicas, updatedAt: sql`now()` })
          .where(eq(tasks.id, task.id));
        await recordValidation(tx, task.id, null, 'pending', {
          needed_replicas: outcome.needed_replicas,
        });
      }
      const [after] = await tx
        .select({ status: tasks.status })
        .from(tasks)
        .where(eq(tasks.id, task.id));
      return (after?.status ?? 'PENDING') as TaskStatus;
    }
    case 'unresolved': {
      await tx
        .update(tasks)
        .set({ status: 'FAILED', completedAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(tasks.id, task.id));
      await recordValidation(tx, task.id, null, 'unresolved', { replicas: candidates.length });
      return 'FAILED';
    }
  }
}

export async function failTask(
  db: Database,
  taskId: string,
  request: TaskFailRequest,
  config: CoordinatorConfig,
): Promise<TaskStatus> {
  return db.transaction(async (tx) => {
    const lease = await lockLease(tx, request.lease_id, request.worker_id, taskId);
    assertLeaseActive(lease);
    await endLease(tx, lease, 'failed', { failureCount: sql`${tasks.failureCount} + 1` });
    const [row] = await tx
      .update(tasks)
      .set({ status: 'FAILED', completedAt: sql`now()`, updatedAt: sql`now()` })
      .where(
        and(
          eq(tasks.id, taskId),
          sql`${tasks.failureCount} >= ${config.maxTaskFailures}`,
          sql`${tasks.status} NOT IN ${TERMINAL}`,
        ),
      )
      .returning({ status: tasks.status });
    if (row) return 'FAILED';
    const [after] = await tx
      .select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, taskId));
    return (after?.status ?? 'PENDING') as TaskStatus;
  });
}
