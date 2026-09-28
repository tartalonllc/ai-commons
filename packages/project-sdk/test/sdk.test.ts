import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectDefinition, TaskInput } from '@ai-commons/protocol';
import { describe, expect, it } from 'vitest';
import {
  CoordinatorAdminClient,
  CoordinatorAdminError,
  defineProject,
  JsonlParseError,
  loadProjectManifest,
  ProjectDefinitionError,
  readJsonl,
  TaskPayloadError,
  type FetchLike,
} from '../src/index.js';

const base: ProjectDefinition = {
  id: 'demo-project',
  name: 'Demo',
  description: 'Demo project',
  version: '1.0.0',
  category: 'science',
  input_schema: {
    type: 'object',
    required: ['title', 'abstract'],
    properties: { title: { type: 'string' }, abstract: { type: 'string', maxLength: 100 } },
  },
  output_schema: {
    type: 'object',
    required: ['field'],
    properties: { field: { type: 'string' }, confidence: { type: 'number' } },
  },
  prompt: { system: 'Classify.', user: '{{title}}\n{{abstract}}' },
  requirements: {
    capability: 'text_generation',
    minimum_context_window: 8192,
    max_output_tokens: 300,
    local_models_only: false,
  },
  validation: { mode: 'consensus', replication_factor: 2, consensus_fields: ['field'] },
};

function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof ProjectDefinitionError) return error.issues.map((i) => i.message);
    throw error;
  }
  throw new Error('expected ProjectDefinitionError');
}

describe('defineProject', () => {
  it('returns a valid definition unchanged', () => {
    expect(defineProject(base)).toBe(base);
  });

  it('rejects protocol-invalid definitions', () => {
    expect(() => defineProject({ ...base, id: 'Bad Id' })).toThrow(ProjectDefinitionError);
  });

  it('reports every issue at once', () => {
    const messages = issuesOf(() =>
      defineProject({
        ...base,
        prompt: { system: '{{secret}}', user: '{{title}} {{missing}}' },
        output_schema: { type: 'object', properties: { x: { $ref: '#/x' } } },
      }),
    );
    expect(messages).toEqual(
      expect.arrayContaining([
        'unsupported keyword "$ref"',
        'placeholder "{{secret}}" is not an input_schema property',
        'placeholder "{{missing}}" is not an input_schema property',
        '"field" is not an output_schema property',
      ]),
    );
  });

  it('requires consensus fields in consensus mode', () => {
    const validation = { mode: 'consensus' as const, replication_factor: 2 };
    expect(issuesOf(() => defineProject({ ...base, validation }))).toContain(
      'consensus mode requires at least one consensus field',
    );
  });
});

describe('files', () => {
  it('loads a JSON manifest and streams JSONL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sdk-'));
    const manifest = join(dir, 'project.json');
    await writeFile(manifest, JSON.stringify(base));
    await expect(loadProjectManifest(manifest)).resolves.toEqual(base);

    const jsonl = join(dir, 'tasks.jsonl');
    await writeFile(jsonl, '{"a":1}\r\n\n{"a":2}\n');
    const rows = [];
    for await (const row of readJsonl(jsonl)) rows.push(row);
    expect(rows).toEqual([{ a: 1 }, { a: 2 }]);

    await writeFile(jsonl, '{"a":1}\n[1]\n');
    await expect(async () => {
      for await (const _row of readJsonl(jsonl)) void _row;
    }).rejects.toThrow(JsonlParseError);
  });
});

interface Call {
  url: string;
  init: RequestInit;
}

function mockFetch(handler: (call: Call) => Response): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      const call = { url, init };
      calls.push(call);
      return handler(call);
    },
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const task = (i: number): TaskInput => ({
  id: `t${i}`,
  payload: { title: `T${i}`, abstract: 'A' },
});

describe('CoordinatorAdminClient', () => {
  it('creates projects with bearer auth and validates the response', async () => {
    const now = '2026-09-28T12:00:00.000Z';
    const { fetch, calls } = mockFetch(() =>
      json({ ...base, status: 'active', created_at: now, updated_at: now }, 201),
    );
    const client = new CoordinatorAdminClient({ baseUrl: 'http://c/', adminToken: 'tok', fetch });
    const project = await client.createProject(base);
    expect(project.status).toBe('active');
    expect(calls[0]?.url).toBe('http://c/api/v1/projects');
    expect((calls[0]?.init.headers as Record<string, string>)['authorization']).toBe('Bearer tok');
  });

  it('batches ingestion at the requested size', async () => {
    const { fetch, calls } = mockFetch((call) => {
      const { tasks } = JSON.parse(call.init.body as string) as { tasks: TaskInput[] };
      return json({ created: tasks.length, task_ids: tasks.map((t) => t.id) }, 201);
    });
    const client = new CoordinatorAdminClient({ baseUrl: 'http://c', adminToken: 't', fetch });
    const tasks = Array.from({ length: 5 }, (_, i) => task(i));
    const result = await client.ingestTasks(base, tasks, { batchSize: 2 });
    expect(calls.map((c) => c.url)).toEqual(
      Array(3).fill('http://c/api/v1/projects/demo-project/tasks'),
    );
    expect(result).toEqual({ created: 5, task_ids: ['t0', 't1', 't2', 't3', 't4'], skipped: [] });
  });

  it('never sends invalid payloads', async () => {
    const { fetch, calls } = mockFetch(() => json({ created: 1, task_ids: ['t0'] }));
    const client = new CoordinatorAdminClient({ baseUrl: 'http://c', adminToken: 't', fetch });
    const bad: TaskInput = { payload: { title: 'x', abstract: 'y'.repeat(101) } };

    await expect(client.ingestTasks(base, [bad])).rejects.toThrow(TaskPayloadError);
    expect(calls).toHaveLength(0);

    const result = await client.ingestTasks(base, [task(0), bad], { skipInvalid: true });
    expect(result.skipped).toEqual([
      { index: 1, issues: [expect.objectContaining({ path: '/payload/abstract' })] },
    ]);
    expect(calls).toHaveLength(1);
  });

  it('rejects oversized payloads', async () => {
    const { fetch } = mockFetch(() => json({ created: 0, task_ids: [] }));
    const client = new CoordinatorAdminClient({ baseUrl: 'http://c', adminToken: 't', fetch });
    const huge: TaskInput = { payload: { title: 'x'.repeat(1_100_000), abstract: 'a' } };
    const loose = { ...base, input_schema: { type: 'object' } };
    await expect(client.ingestTasks(loose, [huge])).rejects.toThrow(/exceeds/);
  });

  it('surfaces coordinator errors and invalid responses', async () => {
    const errorFetch = mockFetch(() =>
      json({ error: { code: 'unauthorized', message: 'bad token' } }, 401),
    );
    const client = new CoordinatorAdminClient({
      baseUrl: 'http://c',
      adminToken: 't',
      fetch: errorFetch.fetch,
    });
    await expect(client.getProjectStats('demo-project')).rejects.toMatchObject({
      status: 401,
      code: 'unauthorized',
    });

    const garbage = mockFetch(() => json({ nope: true }));
    const client2 = new CoordinatorAdminClient({
      baseUrl: 'http://c',
      adminToken: 't',
      fetch: garbage.fetch,
    });
    await expect(client2.getProjectStats('demo-project')).rejects.toBeInstanceOf(
      CoordinatorAdminError,
    );
  });
});
