import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BudgetLimiter, toMicros } from '../src/budget.js';
import { WorkerDatabase } from '../src/db.js';

const T0 = Date.parse('2026-09-28T12:00:00.000Z');

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dbs: WorkerDatabase[] = [];
function memDb() {
  const db = new WorkerDatabase(':memory:');
  dbs.push(db);
  return db;
}
afterEach(() => {
  while (dbs.length) dbs.pop()?.close();
});

const req = (max_usd: number) => ({ provider: 'openai', model: 'm', taskId: 't', max_usd });

describe('BudgetLimiter', () => {
  it('rounds costs up to whole micro-dollars', () => {
    expect(toMicros(0.1)).toBe(100_000);
    expect(toMicros(0.0000001)).toBe(1);
    expect(toMicros(0)).toBe(0);
  });

  it('refuses all remote calls when limits are zero', () => {
    const b = new BudgetLimiter(
      memDb(),
      () => ({ daily_usd: 0, monthly_usd: 5 }),
      () => T0,
    );
    expect(b.reserve(req(0)).ok).toBe(false);
  });

  it('refuses invalid estimates', () => {
    const b = new BudgetLimiter(
      memDb(),
      () => ({ daily_usd: 1, monthly_usd: 5 }),
      () => T0,
    );
    for (const bad of [NaN, -1, Infinity]) expect(b.reserve(req(bad)).ok).toBe(false);
  });

  it('counts open reservations against the limit and releases them', () => {
    const b = new BudgetLimiter(
      memDb(),
      () => ({ daily_usd: 0.25, monthly_usd: 5 }),
      () => T0,
    );
    const r1 = b.reserve(req(0.2));
    expect(r1.ok).toBe(true);
    expect(b.reserve(req(0.1)).ok).toBe(false);
    if (r1.ok) b.settle(r1.reservationId, { actual_usd: 0.05 });
    expect(b.spent().day_usd).toBeCloseTo(0.05);
    expect(b.reserve(req(0.2)).ok).toBe(true);
  });

  it('enforces the monthly limit across days', () => {
    let now = T0;
    const b = new BudgetLimiter(
      memDb(),
      () => ({ daily_usd: 1, monthly_usd: 1.5 }),
      () => now,
    );
    const r = b.reserve(req(1));
    if (r.ok) b.settle(r.reservationId, { actual_usd: 1 });
    now += 24 * 3600_000;
    expect(b.reserve(req(0.6))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('monthly'),
    });
    expect(b.reserve(req(0.5)).ok).toBe(true);
  });

  it('charges the full reservation when actual cost is unknown', () => {
    const b = new BudgetLimiter(
      memDb(),
      () => ({ daily_usd: 1, monthly_usd: 5 }),
      () => T0,
    );
    const r = b.reserve(req(0.3));
    if (r.ok) b.settle(r.reservationId, { actual_usd: Number.NaN });
    expect(b.spent().day_usd).toBeCloseTo(0.3);
  });

  it('treats crashed (stale) reservations as spent', () => {
    let now = T0;
    const db = memDb();
    const b = new BudgetLimiter(
      db,
      () => ({ daily_usd: 1, monthly_usd: 5 }),
      () => now,
      1000,
    );
    b.reserve(req(0.4));
    now += 5000;
    expect(b.reconcileStale()).toBe(1);
    expect(b.spent().day_usd).toBeCloseTo(0.4);
    expect(db.get(`SELECT status FROM usage`)?.status).toBe('orphaned');
  });

  it('blocks further calls once actual cost overruns the estimate', () => {
    const b = new BudgetLimiter(
      memDb(),
      () => ({ daily_usd: 0.25, monthly_usd: 5 }),
      () => T0,
    );
    const r = b.reserve(req(0.1));
    if (r.ok) b.settle(r.reservationId, { actual_usd: 0.3 });
    expect(b.spent().day_usd).toBeCloseTo(0.3);
    expect(b.reserve(req(0.000001)).ok).toBe(false);
  });

  it('is shared across connections to the same database file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aic-budget-'));
    try {
      const file = join(dir, 'w.db');
      const a = new WorkerDatabase(file);
      const c = new WorkerDatabase(file);
      dbs.push(a, c);
      const limits = () => ({ daily_usd: 0.3, monthly_usd: 5 });
      const ba = new BudgetLimiter(a, limits, () => T0);
      const bc = new BudgetLimiter(c, limits, () => T0);
      expect(ba.reserve(req(0.2)).ok).toBe(true);
      expect(bc.reserve(req(0.2)).ok).toBe(false);
      expect(bc.reserve(req(0.1)).ok).toBe(true);
      a.close();
      c.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('BudgetLimiter properties', () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    'spend never exceeds limits when actual <= estimate (seed %i)',
    async (seed) => {
      const rand = mulberry32(seed);
      let now = T0;
      const limits = { daily_usd: 0.25, monthly_usd: 1.0 };
      const b = new BudgetLimiter(
        memDb(),
        () => limits,
        () => now,
      );

      const inflight: Promise<void>[] = [];
      for (let i = 0; i < 400; i++) {
        if (rand() < 0.05) now += 6 * 3600_000;
        const estimate = rand() * 0.05;
        const r = b.reserve(req(estimate));
        const spent = b.spent();
        expect(spent.day_usd).toBeLessThanOrEqual(limits.daily_usd + 1e-9);
        expect(spent.month_usd).toBeLessThanOrEqual(limits.monthly_usd + 1e-9);
        if (r.ok) {
          const actual = rand() < 0.1 ? Number.NaN : estimate * rand();
          inflight.push(
            new Promise<void>((resolve) =>
              setTimeout(
                () => {
                  b.settle(r.reservationId, { actual_usd: actual });
                  resolve();
                },
                Math.floor(rand() * 3),
              ),
            ),
          );
        }
        if (rand() < 0.2) await Promise.race([...inflight, Promise.resolve()]);
      }
      await Promise.all(inflight);
      const final = b.spent();
      expect(final.day_usd).toBeLessThanOrEqual(limits.daily_usd + 1e-9);
      expect(final.month_usd).toBeLessThanOrEqual(limits.monthly_usd + 1e-9);
    },
  );

  it.each([11, 12, 13, 14])(
    'overruns are bounded by in-flight overshoot and then block all calls (seed %i)',
    async (seed) => {
      const rand = mulberry32(seed);
      const limits = { daily_usd: 0.25, monthly_usd: 10 };
      const b = new BudgetLimiter(
        memDb(),
        () => limits,
        () => T0,
      );
      let overshoot = 0;
      const inflight: Promise<void>[] = [];

      for (let i = 0; i < 300; i++) {
        const estimate = rand() * 0.03;
        const before = b.spent().day_usd;
        const r = b.reserve(req(estimate));
        if (before >= limits.daily_usd) expect(r.ok).toBe(false);
        if (r.ok) {
          const actual = estimate * (0.5 + rand() * 1.5);
          overshoot += Math.max(0, actual - r.reserved_usd);
          inflight.push(
            new Promise<void>((resolve) =>
              setTimeout(
                () => {
                  b.settle(r.reservationId, { actual_usd: actual });
                  resolve();
                },
                Math.floor(rand() * 3),
              ),
            ),
          );
        }
        if (rand() < 0.3) await Promise.race([...inflight, Promise.resolve()]);
      }
      await Promise.all(inflight);
      const spent = b.spent().day_usd;
      expect(spent).toBeLessThanOrEqual(limits.daily_usd + overshoot + 1e-6);
      if (spent >= limits.daily_usd) expect(b.reserve(req(0.000001)).ok).toBe(false);
    },
  );
});
