import { num, type WorkerDatabase } from './db.js';

export interface LocalTotals {
  tasks_submitted: number;
  tasks_failed: number;
  input_tokens: number;
  output_tokens: number;
  local_inference_ms: number;
  api_cost_usd: number;
}

function totals(db: WorkerDatabase, where: string, param?: string): LocalTotals {
  const params = param === undefined ? [] : [param];
  const usage = db.get(
    `SELECT
       COALESCE(SUM(input_tokens), 0) AS input_tokens,
       COALESCE(SUM(output_tokens), 0) AS output_tokens,
       COALESCE(SUM(CASE WHEN provider_kind = 'local' THEN duration_ms ELSE 0 END), 0) AS local_ms,
       COALESCE(SUM(CASE WHEN provider_kind = 'remote' THEN
         CASE status WHEN 'settled' THEN actual_cost_micros ELSE reserved_micros END ELSE 0 END), 0) AS cost
     FROM usage ${where}`,
    ...params,
  );
  const taskWhere = where.replace(/\b(day|month)\b/, (m) =>
    m === 'day'
      ? "strftime('%Y-%m-%d', created_at / 1000, 'unixepoch')"
      : "strftime('%Y-%m', created_at / 1000, 'unixepoch')",
  );
  const tasks = db.get(
    `SELECT
       COALESCE(SUM(CASE WHEN status = 'submitted' THEN 1 ELSE 0 END), 0) AS submitted,
       COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed
     FROM tasks ${taskWhere}`,
    ...params,
  );
  return {
    tasks_submitted: num(tasks?.submitted),
    tasks_failed: num(tasks?.failed),
    input_tokens: num(usage?.input_tokens),
    output_tokens: num(usage?.output_tokens),
    local_inference_ms: num(usage?.local_ms),
    api_cost_usd: num(usage?.cost) / 1_000_000,
  };
}

export function localTotals(db: WorkerDatabase, now = Date.now()) {
  const iso = new Date(now).toISOString();
  return {
    today: totals(db, 'WHERE day = ?', iso.slice(0, 10)),
    month: totals(db, 'WHERE month = ?', iso.slice(0, 7)),
    all_time: totals(db, ''),
  };
}
