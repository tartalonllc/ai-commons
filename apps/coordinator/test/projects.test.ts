import type { CreateTasksResponse, Project, ProjectList, ProjectStats } from '@ai-commons/protocol';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  admin,
  Client,
  createHarness,
  projectDefinition,
  resetDatabase,
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

const post = (url: string, payload: unknown, headers: Record<string, string> = admin) =>
  h.app.inject({ method: 'POST', url: `/api/v1${url}`, headers, payload: payload as object });

describe('admin authentication', () => {
  it('requires the admin token for project creation and ingestion', async () => {
    expect((await post('/projects', projectDefinition(), {})).statusCode).toBe(401);
    expect(
      (await post('/projects', projectDefinition(), { authorization: 'Bearer wrong' })).statusCode,
    ).toBe(401);
    await client.createProject();
    const tasks = { tasks: [{ payload: { title: 't', abstract: 'a' } }] };
    expect((await post('/projects/open-literature-demo/tasks', tasks, {})).statusCode).toBe(401);
    const stats = await h.app.inject({
      method: 'GET',
      url: '/api/v1/projects/open-literature-demo/stats',
    });
    expect(stats.statusCode).toBe(401);
  });
});

describe('project creation', () => {
  it('creates, lists, and fetches projects', async () => {
    const res = await post('/projects', projectDefinition());
    expect(res.statusCode).toBe(201);
    expect(res.json<Project>()).toMatchObject({ id: 'open-literature-demo', status: 'active' });

    const list = await h.app.inject({ method: 'GET', url: '/api/v1/projects' });
    expect(list.json<ProjectList>().projects.map((p) => p.id)).toEqual(['open-literature-demo']);

    const one = await h.app.inject({ method: 'GET', url: '/api/v1/projects/open-literature-demo' });
    expect(one.json<Project>().prompt.user).toContain('{{abstract}}');

    const missing = await h.app.inject({ method: 'GET', url: '/api/v1/projects/nope-project' });
    expect(missing.statusCode).toBe(404);
  });

  it('returns 409 conflict for an existing project id', async () => {
    await client.createProject();
    const res = await post('/projects', projectDefinition());
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('conflict');
  });

  it('rejects prompt placeholders that are not input properties', async () => {
    const res = await post(
      '/projects',
      projectDefinition({ prompt: { system: '', user: '{{title}} {{secret_field}}' } }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('secret_field');
  });

  it('rejects consensus projects with missing or unknown consensus fields', async () => {
    const missing = await post(
      '/projects',
      projectDefinition({ validation: { mode: 'consensus', replication_factor: 2 } }),
    );
    expect(missing.statusCode).toBe(400);
    const unknown = await post(
      '/projects',
      projectDefinition({
        validation: { mode: 'consensus', replication_factor: 2, consensus_fields: ['nope'] },
      }),
    );
    expect(unknown.statusCode).toBe(400);
  });

  it('rejects schemas with $ref', async () => {
    const res = await post(
      '/projects',
      projectDefinition({
        output_schema: {
          type: 'object',
          properties: { field: { $ref: 'https://evil.example/x.json' } },
        },
        validation: { mode: 'schema', replication_factor: 1 },
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('$ref');
  });
});

describe('task ingestion', () => {
  beforeEach(() => client.createProject());

  it('ingests valid tasks with generated ids', async () => {
    const res = await post('/projects/open-literature-demo/tasks', {
      tasks: [
        { payload: { title: 'a', abstract: 'b' } },
        { payload: { title: 'c', abstract: 'd' }, priority: 5 },
      ],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<CreateTasksResponse>();
    expect(body.created).toBe(2);
    expect(body.task_ids[0]).toMatch(/^task_/);

    const stats = await h.app.inject({
      method: 'GET',
      url: '/api/v1/projects/open-literature-demo/stats',
      headers: admin,
    });
    expect(stats.json<ProjectStats>()).toMatchObject({ tasks_total: 2, tasks_pending: 2 });
  });

  it('rejects payloads that do not match the input schema, inserting nothing', async () => {
    const res = await post('/projects/open-literature-demo/tasks', {
      tasks: [
        { payload: { title: 'ok', abstract: 'ok' } },
        { payload: { title: 'missing abstract' } },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('tasks[1]');
    const { rows } = await h.handle.pool.query('SELECT count(*)::int AS n FROM tasks');
    expect(rows[0].n).toBe(0);
  });

  it('rejects oversized requests', async () => {
    const res = await post('/projects/open-literature-demo/tasks', {
      tasks: [{ payload: { title: 't', abstract: 'x'.repeat(1_200_000) } }],
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('payload_too_large');
  });

  it('rejects a batch containing an existing task id atomically', async () => {
    await client.addTasks('open-literature-demo', 2);
    const res = await post('/projects/open-literature-demo/tasks', {
      tasks: [
        { id: 'fresh_task', payload: { title: 'a', abstract: 'b' } },
        { id: 'task_0001', payload: { title: 'a', abstract: 'b' } },
      ],
    });
    expect(res.statusCode).toBe(409);
    const { rows } = await h.handle.pool.query(
      "SELECT count(*)::int AS n FROM tasks WHERE id = 'fresh_task'",
    );
    expect(rows[0].n).toBe(0);
  });

  it('returns 404 for unknown projects', async () => {
    const res = await post('/projects/unknown-project/tasks', { tasks: [{ payload: {} }] });
    expect(res.statusCode).toBe(404);
  });
});
