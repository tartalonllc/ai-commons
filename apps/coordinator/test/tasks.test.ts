import type { LeaseResponse, WorkerStats } from '@ai-commons/protocol';
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
const schemaMode = projectDefinition({ validation: { mode: 'schema', replication_factor: 1 } });

async function taskRow(id: string) {
  const { rows } = await h.handle.pool.query(
    'SELECT status, active_leases, completed_replicas, replication_factor, failure_count FROM tasks WHERE id = $1',
    [id],
  );
  return rows[0] as {
    status: string;
    active_leases: number;
    completed_replicas: number;
    replication_factor: number;
    failure_count: number;
  };
}

async function stats(w: TestWorker): Promise<WorkerStats> {
  const res = await h.app.inject({ method: 'GET', url: `/api/v1/workers/${w.id}/stats` });
  return res.json<WorkerStats>();
}

async function expireLease(leaseId: string) {
  await h.handle.pool.query(
    "UPDATE task_leases SET expires_at = now() - interval '1 second' WHERE id = $1",
    [leaseId],
  );
}

describe('happy path', () => {
  it('register → lease → submit completes the task and credits the worker', async () => {
    await client.createProject(schemaMode);
    await client.addTasks(PROJECT, 1);
    const w = await TestWorker.register(h.app);

    const task = await w.lease();
    expect(task).toMatchObject({ id: 'task_0000', project_id: PROJECT, project_version: '1.0.0' });
    expect(task?.payload).toEqual({ title: 'Paper 0', abstract: 'Abstract 0' });
    expect(Date.parse(task?.expires_at ?? '') - Date.now()).toBeGreaterThan(14 * 60_000);
    expect((await taskRow('task_0000')).status).toBe('LEASED');

    const res = await w.submit(must(task).id, must(task).lease_id, classification('biology'));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'accepted' });

    expect(await taskRow('task_0000')).toMatchObject({
      status: 'COMPLETED',
      active_leases: 0,
      completed_replicas: 1,
    });
    expect(await stats(w)).toMatchObject({
      tasks_completed: 1,
      tasks_validated: 1,
      input_tokens: 100,
      output_tokens: 20,
      local_inference_ms: 1000,
      total_execution_ms: 1000,
      api_cost_usd: 0,
      ai_compute_units: 0,
    });
  });

  it('returns no task with a retry hint when the queue is empty', async () => {
    const w = await TestWorker.register(h.app);
    const res = await w.post('/tasks/lease', {
      worker_id: w.id,
      capabilities: { text_generation: true, local_inference: true, max_context_window: 8192 },
    });
    expect(res.json<LeaseResponse>()).toEqual({ task: null, retry_after_ms: 30_000 });
  });

  it('accepts the /results alias from §24', async () => {
    await client.createProject(schemaMode);
    await client.addTasks(PROJECT, 1);
    const w = await TestWorker.register(h.app);
    const task = must(await w.lease());
    const res = await w.post(
      `/tasks/${task.id}/results`,
      w.submission(task.lease_id, classification('x')),
    );
    expect(res.json()).toEqual({ status: 'accepted' });
  });
});

describe('leasing rules', () => {
  it('never leases the same task to the same worker twice', async () => {
    await client.createProject();
    await client.addTasks(PROJECT, 1);
    const w = await TestWorker.register(h.app);
    const first = await w.lease();
    expect(first?.id).toBe('task_0000');
    expect(await w.lease()).toBeNull();
    await w.submit(must(first).id, must(first).lease_id, classification('biology'));
    expect(await w.lease()).toBeNull();
  });

  it('concurrent lease requests never double-assign a task', async () => {
    await client.createProject(schemaMode);
    await client.addTasks(PROJECT, 10);
    const workers = await Promise.all(Array.from({ length: 20 }, () => TestWorker.register(h.app)));

    const leased = await Promise.all(workers.map((w) => w.lease()));
    const ids = leased.filter((t) => t !== null).map((t) => t.id);
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);

    const { rows } = await h.handle.pool.query(
      "SELECT task_id, count(*)::int AS n FROM task_leases WHERE status = 'active' GROUP BY task_id HAVING count(*) > 1",
    );
    expect(rows).toEqual([]);
  });

  it('concurrent leasing respects replication factor', async () => {
    await client.createProject(); // consensus, replication_factor 2
    await client.addTasks(PROJECT, 5);
    const workers = await Promise.all(Array.from({ length: 20 }, () => TestWorker.register(h.app)));

    // SKIP LOCKED means a request can come back empty while rows are briefly
    // locked by peers; such workers simply poll again.
    const leased = await Promise.all(workers.map((w) => w.lease()));
    for (const [i, w] of workers.entries()) {
      if (leased[i] === null) leased[i] = await w.lease();
    }
    expect(leased.filter((t) => t !== null)).toHaveLength(10);

    const { rows } = await h.handle.pool.query(
      "SELECT task_id, count(DISTINCT worker_id)::int AS n FROM task_leases WHERE status = 'active' GROUP BY task_id",
    );
    expect(rows).toHaveLength(5);
    for (const row of rows) expect(row.n).toBe(2);
  });

  it('routes local_models_only projects only to workers with local inference', async () => {
    await client.createProject(
      projectDefinition({
        requirements: { ...schemaMode.requirements, local_models_only: true },
        validation: schemaMode.validation,
      }),
    );
    await client.addTasks(PROJECT, 1);
    const remote = await TestWorker.register(h.app, remoteCapabilities);
    const local = await TestWorker.register(h.app);
    expect(await remote.lease()).toBeNull();
    expect((await local.lease())?.id).toBe('task_0000');
  });

  it('filters by category and context window', async () => {
    await client.createProject(schemaMode);
    await client.addTasks(PROJECT, 1);
    const w = await TestWorker.register(h.app);
    expect(await w.lease({ categories: ['history'] })).toBeNull();
    expect(await w.lease({ max_context_window: 4096 })).toBeNull();
    expect((await w.lease({ categories: ['science'] }))?.id).toBe('task_0000');
  });

  it('does not lease tasks from paused projects', async () => {
    await client.createProject(schemaMode);
    await client.addTasks(PROJECT, 1);
    await h.handle.pool.query("UPDATE projects SET status = 'paused'");
    const w = await TestWorker.register(h.app);
    expect(await w.lease()).toBeNull();
  });
});

describe('lease lifecycle', () => {
  it('reclaims expired leases for other workers', async () => {
    await client.createProject(schemaMode);
    await client.addTasks(PROJECT, 1);
    const a = await TestWorker.register(h.app);
    const b = await TestWorker.register(h.app);

    const task = must(await a.lease());
    expect(await b.lease()).toBeNull();
    await expireLease(task.lease_id);

    const reassigned = await b.lease();
    expect(reassigned?.id).toBe(task.id);
    const { rows } = await h.handle.pool.query('SELECT status FROM task_leases WHERE id = $1', [
      task.lease_id,
    ]);
    expect(rows[0].status).toBe('expired');

    const late = await a.submit(task.id, task.lease_id, classification('biology'));
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe('lease_expired');
  });

  it('lets only the owner extend a lease', async () => {
    await client.createProject(schemaMode);
    await client.addTasks(PROJECT, 1);
    const a = await TestWorker.register(h.app);
    const b = await TestWorker.register(h.app);
    const task = must(await a.lease());

    await h.handle.pool.query(
      "UPDATE task_leases SET expires_at = now() + interval '1 minute' WHERE id = $1",
      [task.lease_id],
    );
    const ok = await a.post(`/tasks/${task.id}/extend`, {
      worker_id: a.id,
      lease_id: task.lease_id,
    });
    expect(ok.statusCode).toBe(200);
    expect(Date.parse(ok.json().expires_at) - Date.now()).toBeGreaterThan(14 * 60_000);

    const foreign = await b.post(`/tasks/${task.id}/extend`, {
      worker_id: b.id,
      lease_id: task.lease_id,
    });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json().error.code).toBe('forbidden');

    await expireLease(task.lease_id);
    const expired = await a.post(`/tasks/${task.id}/extend`, {
      worker_id: a.id,
      lease_id: task.lease_id,
    });
    expect(expired.statusCode).toBe(409);
  });

  it("rejects submissions against another worker's lease or a mismatched task", async () => {
    await client.createProject(schemaMode);
    await client.addTasks(PROJECT, 2);
    const a = await TestWorker.register(h.app);
    const b = await TestWorker.register(h.app);
    const task = must(await a.lease());

    const foreign = await b.submit(task.id, task.lease_id, classification('x'));
    expect(foreign.statusCode).toBe(403);

    const wrongTask = await a.submit('task_0001', task.lease_id, classification('x'));
    expect(wrongTask.statusCode).toBe(404);

    const unknown = await a.submit(task.id, 'lease_doesnotexist', classification('x'));
    expect(unknown.statusCode).toBe(404);
  });

  it('returns failed tasks to the queue and marks FAILED after 3 failures', async () => {
    await client.createProject(schemaMode);
    await client.addTasks(PROJECT, 1);
    const workers = await Promise.all([1, 2, 3, 4].map(() => TestWorker.register(h.app)));

    for (const [i, w] of workers.slice(0, 3).entries()) {
      const task = must(await w.lease());
      expect(task.id).toBe('task_0000');
      const res = await w.post(`/tasks/${task.id}/fail`, {
        worker_id: w.id,
        lease_id: task.lease_id,
        reason: 'provider_error',
        attempts: 3,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().task_status).toBe(i < 2 ? 'PENDING' : 'FAILED');
    }
    expect(await taskRow('task_0000')).toMatchObject({
      status: 'FAILED',
      failure_count: 3,
      active_leases: 0,
    });
    const fourth = workers[3];
    expect(await fourth?.lease()).toBeNull();
  });
});
