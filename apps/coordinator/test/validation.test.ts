import type { WorkerStats } from '@ai-commons/protocol';
import { resultHash } from '@ai-commons/validators';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  classification,
  Client,
  createHarness,
  projectDefinition,
  remoteCapabilities,
  resetDatabase,
  TestWorker,
  must,
  type Harness,
} from './harness.js';

let h: Harness;
let client: Client;
beforeAll(async () => {
  h = await createHarness();
  client = new Client(h.app);
});
afterAll(() => h.close());
beforeEach(() => resetDatabase(h.handle));

const PROJECT = 'open-literature-demo';

async function task(id = 'task_0000') {
  const { rows } = await h.handle.pool.query(
    'SELECT status, replication_factor, accepted_result_id, consensus_key FROM tasks WHERE id = $1',
    [id],
  );
  return rows[0] as {
    status: string;
    replication_factor: number;
    accepted_result_id: string | null;
  };
}

const stats = async (w: TestWorker) =>
  (await h.app.inject({ method: 'GET', url: `/api/v1/workers/${w.id}/stats` })).json<WorkerStats>();

async function run(w: TestWorker, field: string) {
  const leased = await w.lease();
  if (!leased) throw new Error(`${w.id} got no task`);
  const res = await w.submit(leased.id, leased.lease_id, classification(field));
  expect(res.statusCode).toBe(200);
  return res.json<{ status: string }>();
}

describe('consensus validation', () => {
  beforeEach(async () => {
    await client.createProject();
    await client.addTasks(PROJECT, 1);
  });

  it('accepts when two replicas agree', async () => {
    const [a, b] = await Promise.all([TestWorker.register(h.app), TestWorker.register(h.app)]);
    await run(must(a), 'biology');
    expect((await task()).status).toBe('PENDING');
    await run(must(b), 'Biology ');
    const t = await task();
    expect(t.status).toBe('COMPLETED');
    expect(t.accepted_result_id).not.toBeNull();
    expect((await stats(must(a))).tasks_validated).toBe(1);
    expect((await stats(must(b))).tasks_validated).toBe(1);
  });

  it('requests a tie-breaker on disagreement and credits only the majority', async () => {
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => TestWorker.register(h.app)));
    await run(must(a), 'biology');
    await run(must(b), 'chemistry');
    expect(await task()).toMatchObject({ status: 'PENDING', replication_factor: 3 });

    await run(must(c), 'biology');
    expect((await task()).status).toBe('COMPLETED');
    expect((await stats(must(a))).tasks_validated).toBe(1);
    expect((await stats(must(b))).tasks_validated).toBe(0);
    expect((await stats(must(b))).tasks_completed).toBe(1);
    expect((await stats(must(c))).tasks_validated).toBe(1);

    const { rows } = await h.handle.pool.query(
      "SELECT detail FROM validations WHERE task_id = 'task_0000' AND outcome = 'accepted'",
    );
    expect(rows[0].detail.dissenting).toEqual([must(b).id]);
  });

  it('marks the task FAILED when no majority emerges by the replica cap', async () => {
    const workers = await Promise.all([1, 2, 3, 4, 5].map(() => TestWorker.register(h.app)));
    const fields = ['biology', 'chemistry', 'physics', 'astronomy', 'geology'];
    for (const [i, w] of workers.entries()) await run(w, must(fields[i]));
    expect((await task()).status).toBe('FAILED');
    const extra = await TestWorker.register(h.app);
    expect(await extra.lease()).toBeNull();
  });

  it('stores a result hash binding task, result, and worker', async () => {
    const [a] = await Promise.all([TestWorker.register(h.app)]);
    await run(must(a), 'biology');
    const { rows } = await h.handle.pool.query('SELECT result, result_hash FROM results');
    expect(rows[0].result_hash).toBe(resultHash('task_0000', rows[0].result, must(a).id));
  });
});

describe('result checks', () => {
  beforeEach(async () => {
    await client.createProject(
      projectDefinition({ validation: { mode: 'schema', replication_factor: 1 } }),
    );
    await client.addTasks(PROJECT, 1);
  });

  it('rejects results that fail the output schema and returns the task to the pool', async () => {
    const a = await TestWorker.register(h.app);
    const leased = must(await a.lease());
    const res = await a.submit(leased.id, leased.lease_id, { field: 'biology', confidence: 7 });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('rejected');
    expect(res.json().reason).toContain('output_schema');

    expect((await task()).status).toBe('PENDING');
    expect((await stats(a)).tasks_completed).toBe(0);

    const retry = await a.submit(leased.id, leased.lease_id, classification('biology'));
    expect(retry.statusCode).toBe(409);

    const b = await TestWorker.register(h.app);
    expect((await b.lease())?.id).toBe('task_0000');
  });

  it('rejects results over the size limit', async () => {
    const a = await TestWorker.register(h.app);
    const leased = must(await a.lease());
    const res = await a.submit(leased.id, leased.lease_id, {
      ...classification('biology'),
      topics: Array.from({ length: 2000 }, () => 'x'.repeat(20)),
    });
    expect(res.json().status).toBe('rejected');
  });

  it('treats resubmission as an idempotent duplicate without extra credit', async () => {
    const a = await TestWorker.register(h.app);
    const leased = must(await a.lease());
    const first = await a.submit(leased.id, leased.lease_id, classification('biology'));
    const second = await a.submit(leased.id, leased.lease_id, classification('biology'));
    expect(first.json().status).toBe('accepted');
    expect(second.statusCode).toBe(200);
    expect(second.json().status).toBe('duplicate');
    expect(await stats(a)).toMatchObject({
      tasks_completed: 1,
      tasks_validated: 1,
      input_tokens: 100,
    });
    const { rows } = await h.handle.pool.query('SELECT count(*)::int AS n FROM results');
    expect(rows[0].n).toBe(1);
  });

  it('derives ACUs only from API cost reported by remote providers', async () => {
    const remote = await TestWorker.register(h.app, remoteCapabilities);
    const leased = must(await remote.lease());
    await remote.submit(leased.id, leased.lease_id, classification('biology'), 0.0042);
    const s = await stats(remote);
    expect(s.api_cost_usd).toBeCloseTo(0.0042);
    expect(s.ai_compute_units).toBeCloseTo(4.2);
    expect(s.local_inference_ms).toBe(0);
  });

  it('ignores cost claims from local providers', async () => {
    const local = await TestWorker.register(h.app);
    const leased = must(await local.lease());
    await local.submit(leased.id, leased.lease_id, classification('biology'), 5);
    const s = await stats(local);
    expect(s.api_cost_usd).toBe(0);
    expect(s.local_inference_ms).toBe(1000);
  });
});

describe('observability', () => {
  it('reports metrics and a privacy-safe network summary', async () => {
    await client.createProject(
      projectDefinition({ validation: { mode: 'schema', replication_factor: 1 } }),
    );
    await client.addTasks(PROJECT, 3);
    const a = await TestWorker.register(h.app);
    await run(a, 'biology');
    await a.lease();

    const metrics = await h.app.inject({ method: 'GET', url: '/api/v1/metrics' });
    expect(metrics.json()).toMatchObject({
      worker_count: 1,
      active_worker_count: 1,
      task_queue_depth: 1,
      task_completion_rate: 1,
      task_failure_rate: 0,
      average_task_duration_ms: 1000,
    });

    const network = await h.app.inject({ method: 'GET', url: '/api/v1/network' });
    const body = network.json();
    expect(body.network).toMatchObject({
      connected_workers: 1,
      active_workers: 1,
      tasks_waiting: 1,
      tasks_processing: 1,
      tasks_completed: 1,
    });
    expect(body.projects[0]).toMatchObject({
      id: PROJECT,
      tasks_total: 3,
      tasks_completed: 1,
      workers: 1,
    });
    expect(body.workers[0]).toEqual({
      worker_id: a.id,
      status: 'available',
      tasks_completed: 1,
      last_seen: expect.any(String),
    });
    expect(network.body).not.toMatch(/ollama|127\.0\.0\.1|windows/);

    const health = await h.app.inject({ method: 'GET', url: '/healthz' });
    expect(health.json()).toEqual({ status: 'ok' });
  });
});
