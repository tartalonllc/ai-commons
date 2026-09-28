import type { WorkerStats } from '@ai-commons/protocol';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashSecret } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { isCompatibleProtocol } from '../src/services/workers.js';
import {
  createHarness,
  localCapabilities,
  resetDatabase,
  TestWorker,
  type Harness,
} from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());
beforeEach(() => resetDatabase(h.handle));

const heartbeat = (w: TestWorker) => ({
  worker_id: w.id,
  status: 'available',
  providers: ['ollama'],
  current_tasks: 0,
});

describe('registration', () => {
  it('issues a random worker id and a secret stored only as a hash', async () => {
    const w = await TestWorker.register(h.app);
    expect(w.id).toMatch(/^worker_[a-z2-7]{16}$/);
    expect(Buffer.from(w.secret, 'base64url')).toHaveLength(32);

    const { rows } = await h.handle.pool.query('SELECT secret_hash FROM workers WHERE id = $1', [
      w.id,
    ]);
    expect(rows[0].secret_hash).toBe(hashSecret(w.secret));
    expect(JSON.stringify(rows)).not.toContain(w.secret);
  });

  it('rejects incompatible protocol versions', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/workers/register',
      payload: { ...localCapabilities, protocol_version: '0.2.0' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('unsupported_protocol_version');
    expect(isCompatibleProtocol('0.1.7')).toBe(true);
  });

  it('rejects unknown fields and malformed capabilities', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/workers/register',
      payload: { ...localCapabilities, api_key: 'sk-should-never-arrive' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_request');
  });
});

describe('worker authentication', () => {
  it('accepts the correct secret', async () => {
    const w = await TestWorker.register(h.app);
    const res = await w.post('/workers/heartbeat', heartbeat(w));
    expect(res.statusCode).toBe(200);
    expect(Date.parse(res.json().server_time)).not.toBeNaN();
  });

  it('rejects a missing bearer token', async () => {
    const w = await TestWorker.register(h.app);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/workers/heartbeat',
      payload: heartbeat(w),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
  });

  it('rejects a wrong secret', async () => {
    const w = await TestWorker.register(h.app);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/workers/heartbeat',
      headers: { authorization: 'Bearer not-the-secret' },
      payload: heartbeat(w),
    });
    expect(res.statusCode).toBe(401);
  });

  it('prevents a worker from acting as another worker', async () => {
    const a = await TestWorker.register(h.app);
    const b = await TestWorker.register(h.app);
    const res = await a.post('/workers/heartbeat', heartbeat(b));
    expect(res.statusCode).toBe(401);
  });

  it('rejects unknown worker ids with the same error', async () => {
    const a = await TestWorker.register(h.app);
    const res = await a.post('/workers/heartbeat', {
      ...heartbeat(a),
      worker_id: 'worker_zzzzzzzzzz',
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('capabilities and stats', () => {
  it('replaces capabilities', async () => {
    const w = await TestWorker.register(h.app);
    const res = await w.post('/workers/capabilities', {
      worker_id: w.id,
      capabilities: {
        ...localCapabilities.capabilities,
        providers: [{ provider: 'openai', kind: 'remote', models: [{ name: 'gpt-test' }] }],
      },
    });
    expect(res.statusCode).toBe(204);
    const { rows } = await h.handle.pool.query(
      'SELECT provider FROM worker_capabilities WHERE worker_id = $1',
      [w.id],
    );
    expect(rows).toEqual([{ provider: 'openai' }]);
  });

  it('returns zeroed stats for a new worker and 404 for unknown', async () => {
    const w = await TestWorker.register(h.app);
    const res = await h.app.inject({ method: 'GET', url: `/api/v1/workers/${w.id}/stats` });
    expect(res.statusCode).toBe(200);
    expect(res.json<WorkerStats>()).toMatchObject({
      tasks_completed: 0,
      api_cost_usd: 0,
      ai_compute_units: 0,
    });

    const missing = await h.app.inject({
      method: 'GET',
      url: '/api/v1/workers/worker_zzzzzzzzzz/stats',
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe('rate limiting', () => {
  it('limits registrations per IP with an ApiError body', async () => {
    const limited = await createHarness({ rateLimit: { max: 100, registerMaxPerHour: 2 } });
    try {
      const register = () =>
        limited.app.inject({
          method: 'POST',
          url: '/api/v1/workers/register',
          payload: localCapabilities,
        });
      expect((await register()).statusCode).toBe(201);
      expect((await register()).statusCode).toBe(201);
      const third = await register();
      expect(third.statusCode).toBe(429);
      expect(third.json().error.code).toBe('rate_limited');
    } finally {
      await limited.close();
    }
  });
});

describe('config', () => {
  it('validates required env at startup', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x/y', ADMIN_TOKEN: 'short' })).toThrow(
      /ADMIN_TOKEN/,
    );
    expect(() =>
      loadConfig({ DATABASE_URL: 'postgres://x/y', ADMIN_TOKEN: 'x'.repeat(24), PORT: 'abc' }),
    ).toThrow(/PORT/);
  });
});
