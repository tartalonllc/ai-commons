import { sql } from 'drizzle-orm';
import { parse, WorkerStatus, type Metrics, type NetworkSummary } from '@ai-commons/protocol';
import type { Database } from '../db/client.js';
import { ACU_USD } from './workers.js';

const n = (v: unknown): number => Number(v ?? 0);
/** Worker status is only ever written from validated heartbeats. */
const workerStatus = (v: unknown): WorkerStatus => {
  const result = parse(WorkerStatus, v);
  if (!result.ok) throw new Error('Unexpected worker status in database');
  return result.value;
};
const iso = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString();

/** A worker is connected if it has been seen within three heartbeat intervals. */
const connectedWindow = (heartbeatMs: number) =>
  sql`now() - make_interval(secs => ${(3 * heartbeatMs) / 1000})`;

export async function collectMetrics(db: Database, heartbeatMs: number): Promise<Metrics> {
  const { rows } = await db.execute(sql`
    SELECT
      (SELECT count(*) FROM workers) AS worker_count,
      (SELECT count(*) FROM workers WHERE last_seen_at > ${connectedWindow(heartbeatMs)}
         AND status <> 'paused') AS active_worker_count,
      (SELECT count(*) FROM tasks WHERE status = 'PENDING') AS queue_depth,
      (SELECT count(*) FROM tasks WHERE status = 'COMPLETED') AS completed,
      (SELECT count(*) FROM tasks WHERE status = 'FAILED') AS failed,
      (SELECT coalesce(avg(duration_ms), 0) FROM results) AS avg_duration`);
  const r = rows[0] ?? {};
  const completed = n(r['completed']);
  const failed = n(r['failed']);
  const finished = completed + failed;
  return {
    worker_count: n(r['worker_count']),
    active_worker_count: n(r['active_worker_count']),
    task_queue_depth: n(r['queue_depth']),
    task_completion_rate: finished === 0 ? 0 : completed / finished,
    task_failure_rate: finished === 0 ? 0 : failed / finished,
    average_task_duration_ms: n(r['avg_duration']),
  };
}

export async function networkSummary(db: Database, heartbeatMs: number): Promise<NetworkSummary> {
  const window = connectedWindow(heartbeatMs);
  const totals =
    (
      await db.execute(sql`
      SELECT
        (SELECT count(*) FROM workers WHERE last_seen_at > ${window}) AS connected,
        (SELECT count(DISTINCT worker_id) FROM task_leases
           WHERE status = 'active' AND expires_at > now()) AS active,
        (SELECT count(*) FROM tasks WHERE status = 'PENDING') AS waiting,
        (SELECT count(*) FROM tasks WHERE status = 'LEASED') AS processing,
        (SELECT count(*) FROM tasks WHERE status = 'COMPLETED') AS completed,
        (SELECT count(*) FROM tasks WHERE status = 'FAILED') AS failed,
        (SELECT coalesce(sum(input_tokens), 0) FROM contributions) AS input_tokens,
        (SELECT coalesce(sum(output_tokens), 0) FROM contributions) AS output_tokens,
        (SELECT coalesce(sum(local_inference_ms), 0) FROM contributions) AS local_ms,
        (SELECT coalesce(sum(api_cost_usd), 0) FROM contributions) AS api_cost`)
    ).rows[0] ?? {};

  const projectRows = (
    await db.execute(sql`
      SELECT p.id, p.name,
        (SELECT count(*) FROM tasks t WHERE t.project_id = p.id) AS total,
        (SELECT count(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'COMPLETED') AS completed,
        (SELECT count(DISTINCT r.worker_id) FROM results r JOIN tasks t ON t.id = r.task_id
           WHERE t.project_id = p.id) AS workers
      FROM projects p WHERE p.status <> 'archived' ORDER BY p.created_at`)
  ).rows;

  const workerRows = (
    await db.execute(sql`
      SELECT w.id, w.status, w.last_seen_at, coalesce(c.tasks_completed, 0) AS tasks_completed
      FROM workers w LEFT JOIN contributions c ON c.worker_id = w.id
      ORDER BY w.last_seen_at DESC LIMIT 100`)
  ).rows;

  const apiCost = n(totals['api_cost']);
  return {
    network: {
      connected_workers: n(totals['connected']),
      active_workers: n(totals['active']),
      tasks_waiting: n(totals['waiting']),
      tasks_processing: n(totals['processing']),
      tasks_completed: n(totals['completed']),
      tasks_failed: n(totals['failed']),
    },
    compute: {
      input_tokens: n(totals['input_tokens']),
      output_tokens: n(totals['output_tokens']),
      local_inference_hours: n(totals['local_ms']) / 3_600_000,
      api_cost_usd: apiCost,
      ai_compute_units: apiCost / ACU_USD,
    },
    projects: projectRows.map((p) => {
      const total = n(p['total']);
      const completed = n(p['completed']);
      return {
        id: String(p['id']),
        name: String(p['name']),
        tasks_total: total,
        tasks_completed: completed,
        progress: total === 0 ? 0 : completed / total,
        workers: n(p['workers']),
      };
    }),
    workers: workerRows.map((w) => ({
      worker_id: String(w['id']),
      status: workerStatus(w['status']),
      tasks_completed: n(w['tasks_completed']),
      last_seen: iso(w['last_seen_at']),
    })),
    generated_at: new Date().toISOString(),
  };
}
