import { LIMITS } from '@ai-commons/protocol';
import { num, type WorkerDatabase } from './db.js';

export interface ApiLimits {
  daily_usd: number;
  monthly_usd: number;
}

export interface SpendSnapshot {
  day_usd: number;
  month_usd: number;
}

export type ReserveResult =
  | { ok: true; reservationId: number; reserved_usd: number }
  | { ok: false; reason: string; spent: SpendSnapshot };

export interface SettleInput {
  actual_usd: number;
  input_tokens?: number | undefined;
  output_tokens?: number | undefined;
  duration_ms?: number | undefined;
}

const MICROS_PER_USD = 1_000_000;

/** Rounds up so accounting can never under-count spend. */
export function toMicros(usd: number): number {
  return Math.max(0, Math.ceil(usd * MICROS_PER_USD - 1e-6));
}

const fromMicros = (micros: number) => micros / MICROS_PER_USD;

function windows(nowMs: number): { day: string; month: string } {
  const iso = new Date(nowMs).toISOString();
  return { day: iso.slice(0, 10), month: iso.slice(0, 7) };
}

/** Reserved or orphaned rows count at their reserved amount; settled rows at actual cost. */
const SPEND_EXPR = `COALESCE(SUM(CASE status WHEN 'settled' THEN actual_cost_micros ELSE reserved_micros END), 0)`;

/**
 * Local API spending limiter (spec §19–§20). The coordinator is never trusted
 * with this: every remote call must hold a reservation for its worst-case cost.
 */
export class BudgetLimiter {
  constructor(
    private readonly db: WorkerDatabase,
    private readonly limits: () => ApiLimits,
    private readonly now: () => number = Date.now,
    private readonly staleAfterMs: number = LIMITS.maxTaskRuntimeMs + 60_000,
  ) {}

  private spentMicros(nowMs: number): { day: number; month: number } {
    const w = windows(nowMs);
    const day = num(this.db.get(`SELECT ${SPEND_EXPR} AS s FROM usage WHERE day = ?`, w.day)?.s);
    const month = num(
      this.db.get(`SELECT ${SPEND_EXPR} AS s FROM usage WHERE month = ?`, w.month)?.s,
    );
    return { day, month };
  }

  spent(): SpendSnapshot {
    const s = this.spentMicros(this.now());
    return { day_usd: fromMicros(s.day), month_usd: fromMicros(s.month) };
  }

  /**
   * Reservations left behind by a crash are converted to spend at their full
   * reserved amount. They already count as spent, so this only finalizes them.
   */
  reconcileStale(): number {
    const cutoff = this.now() - this.staleAfterMs;
    const res = this.db.run(
      `UPDATE usage SET status = 'orphaned', actual_cost_micros = reserved_micros, settled_at = ?
       WHERE status = 'reserved' AND created_at < ?`,
      this.now(),
      cutoff,
    );
    return Number(res.changes);
  }

  reserve(input: {
    provider: string;
    model: string;
    taskId: string;
    max_usd: number;
  }): ReserveResult {
    const { max_usd } = input;
    const limits = this.limits();
    const nowMs = this.now();

    if (!Number.isFinite(max_usd) || max_usd < 0) {
      return { ok: false, reason: 'invalid cost estimate', spent: this.spent() };
    }
    if (!(limits.daily_usd > 0) || !(limits.monthly_usd > 0)) {
      return { ok: false, reason: 'API spending is disabled (limit is 0)', spent: this.spent() };
    }

    const needed = toMicros(max_usd);
    const dayLimit = Math.floor(limits.daily_usd * MICROS_PER_USD + 1e-6);
    const monthLimit = Math.floor(limits.monthly_usd * MICROS_PER_USD + 1e-6);

    return this.db.transaction((): ReserveResult => {
      this.reconcileStale();
      const spent = this.spentMicros(nowMs);
      const snapshot = { day_usd: fromMicros(spent.day), month_usd: fromMicros(spent.month) };
      if (spent.day + needed > dayLimit) {
        return { ok: false, reason: 'daily API limit would be exceeded', spent: snapshot };
      }
      if (spent.month + needed > monthLimit) {
        return { ok: false, reason: 'monthly API limit would be exceeded', spent: snapshot };
      }
      const w = windows(nowMs);
      const res = this.db.run(
        `INSERT INTO usage (provider, provider_kind, model, task_id, estimated_cost_micros,
           reserved_micros, status, day, month, created_at)
         VALUES (?, 'remote', ?, ?, ?, ?, 'reserved', ?, ?, ?)`,
        input.provider,
        input.model,
        input.taskId,
        needed,
        needed,
        w.day,
        w.month,
        nowMs,
      );
      return {
        ok: true,
        reservationId: Number(res.lastInsertRowid),
        reserved_usd: fromMicros(needed),
      };
    });
  }

  /**
   * Records actual cost. If actual exceeds the reservation it is still recorded
   * truthfully, which blocks further reservations until the window rolls over.
   */
  settle(reservationId: number, input: SettleInput): void {
    const actual =
      Number.isFinite(input.actual_usd) && input.actual_usd >= 0 ? input.actual_usd : NaN;
    this.db.transaction(() => {
      const row = this.db.get(
        `SELECT reserved_micros, status FROM usage WHERE id = ?`,
        reservationId,
      );
      if (!row || row.status !== 'reserved') return;
      const micros = Number.isNaN(actual) ? num(row.reserved_micros) : toMicros(actual);
      this.db.run(
        `UPDATE usage SET status = 'settled', actual_cost_micros = ?, input_tokens = ?,
           output_tokens = ?, duration_ms = ?, settled_at = ? WHERE id = ?`,
        micros,
        input.input_tokens ?? null,
        input.output_tokens ?? null,
        input.duration_ms ?? null,
        this.now(),
        reservationId,
      );
    });
  }

  /** For failures known to occur before any billing (auth, rate limit, bad request). */
  release(reservationId: number): void {
    this.settle(reservationId, { actual_usd: 0 });
  }

  recordLocalUsage(input: {
    provider: string;
    model: string;
    taskId: string;
    input_tokens?: number | undefined;
    output_tokens?: number | undefined;
    duration_ms: number;
  }): void {
    const nowMs = this.now();
    const w = windows(nowMs);
    this.db.run(
      `INSERT INTO usage (provider, provider_kind, model, task_id, input_tokens, output_tokens,
         actual_cost_micros, status, duration_ms, day, month, created_at, settled_at)
       VALUES (?, 'local', ?, ?, ?, ?, 0, 'settled', ?, ?, ?, ?, ?)`,
      input.provider,
      input.model,
      input.taskId,
      input.input_tokens ?? null,
      input.output_tokens ?? null,
      input.duration_ms,
      w.day,
      w.month,
      nowMs,
      nowMs,
    );
  }
}
