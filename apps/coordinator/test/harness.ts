import type {
  LeaseResponse,
  ProjectDefinition,
  RegisterWorkerRequest,
  RegisterWorkerResponse,
  ResultSubmission,
} from '@ai-commons/protocol';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig, type CoordinatorConfig } from '../src/config.js';
import { connect, type DatabaseHandle } from '../src/db/client.js';

export const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgres://aicommons:aicommons@localhost:55432/aicommons_test';

export const ADMIN_TOKEN = 'test-admin-token-0123456789abcdef';

export interface Harness {
  app: FastifyInstance;
  handle: DatabaseHandle;
  config: CoordinatorConfig;
  close(): Promise<void>;
}

export async function createHarness(overrides: Partial<CoordinatorConfig> = {}): Promise<Harness> {
  const config = {
    ...loadConfig({
      DATABASE_URL: TEST_DATABASE_URL,
      ADMIN_TOKEN,
      RATE_LIMIT_DISABLED: 'true',
    }),
    ...overrides,
  };
  const handle = connect(config.databaseUrl, 25);
  const app = await buildApp({ config, db: handle.db, logger: false });
  await app.ready();
  return {
    app,
    handle,
    config,
    close: async () => {
      await app.close();
      await handle.close();
    },
  };
}

export async function resetDatabase(handle: DatabaseHandle): Promise<void> {
  await handle.pool.query(
    'TRUNCATE validations, results, task_leases, tasks, projects, contributions, worker_capabilities, workers CASCADE',
  );
}

export const outputSchema = {
  type: 'object',
  required: ['field', 'topics', 'contains_experiment', 'confidence'],
  properties: {
    field: { type: 'string' },
    topics: { type: 'array', items: { type: 'string' } },
    contains_experiment: { type: 'boolean' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  additionalProperties: false,
};

export function projectDefinition(overrides: Partial<ProjectDefinition> = {}): ProjectDefinition {
  return {
    id: 'open-literature-demo',
    name: 'Open Literature Classification',
    description: 'Classify scientific abstracts by field and topic.',
    version: '1.0.0',
    category: 'science',
    input_schema: {
      type: 'object',
      required: ['title', 'abstract'],
      properties: { title: { type: 'string' }, abstract: { type: 'string' } },
    },
    output_schema: outputSchema,
    prompt: { system: 'Classify. JSON only.', user: 'Title: {{title}}\n\n{{abstract}}' },
    requirements: {
      capability: 'text_generation',
      minimum_context_window: 8192,
      max_output_tokens: 512,
      local_models_only: false,
    },
    validation: { mode: 'consensus', replication_factor: 2, consensus_fields: ['field'] },
    ...overrides,
  };
}

export const admin = { authorization: `Bearer ${ADMIN_TOKEN}` };

export class Client {
  constructor(private readonly app: FastifyInstance) {}

  inject(options: InjectOptions): Promise<LightMyRequestResponse> {
    return this.app.inject(options);
  }

  async createProject(def: ProjectDefinition = projectDefinition()): Promise<void> {
    const res = await this.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: admin,
      payload: def,
    });
    if (res.statusCode !== 201) throw new Error(`createProject ${res.statusCode}: ${res.body}`);
  }

  async addTasks(projectId: string, count: number, prefix = 'task'): Promise<string[]> {
    const tasks = Array.from({ length: count }, (_, i) => ({
      id: `${prefix}_${String(i).padStart(4, '0')}`,
      payload: { title: `Paper ${i}`, abstract: `Abstract ${i}` },
    }));
    const res = await this.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/tasks`,
      headers: admin,
      payload: { tasks },
    });
    if (res.statusCode !== 201) throw new Error(`addTasks ${res.statusCode}: ${res.body}`);
    return tasks.map((t) => t.id);
  }
}

export const localCapabilities: RegisterWorkerRequest = {
  protocol_version: '0.1.0',
  capabilities: {
    platform: 'windows',
    client_version: '0.1.0',
    providers: [
      { provider: 'ollama', kind: 'local', models: [{ name: 'qwen3:8b', context_window: 32768 }] },
    ],
  },
};

export const remoteCapabilities: RegisterWorkerRequest = {
  protocol_version: '0.1.0',
  capabilities: {
    platform: 'linux',
    client_version: '0.1.0',
    providers: [{ provider: 'openai', kind: 'remote', models: [{ name: 'gpt-test' }] }],
  },
};

export class TestWorker {
  private constructor(
    private readonly app: FastifyInstance,
    readonly id: string,
    readonly secret: string,
    readonly localInference: boolean,
  ) {}

  static async register(
    app: FastifyInstance,
    request: RegisterWorkerRequest = localCapabilities,
  ): Promise<TestWorker> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/workers/register',
      payload: request,
    });
    if (res.statusCode !== 201) throw new Error(`register ${res.statusCode}: ${res.body}`);
    const body = res.json<RegisterWorkerResponse>();
    const local = request.capabilities.providers.some((p) => p.kind === 'local');
    return new TestWorker(app, body.worker_id, body.worker_secret, local);
  }

  get headers() {
    return { authorization: `Bearer ${this.secret}` };
  }

  post(url: string, payload: object): Promise<LightMyRequestResponse> {
    return this.app.inject({
      method: 'POST',
      url: `/api/v1${url}`,
      headers: this.headers,
      payload,
    });
  }

  async lease(extra: Partial<{ categories: string[]; max_context_window: number }> = {}) {
    const res = await this.post('/tasks/lease', {
      worker_id: this.id,
      capabilities: {
        text_generation: true,
        local_inference: this.localInference,
        max_context_window: extra.max_context_window ?? 32768,
      },
      ...(extra.categories ? { categories: extra.categories } : {}),
    });
    if (res.statusCode !== 200) throw new Error(`lease ${res.statusCode}: ${res.body}`);
    return res.json<LeaseResponse>().task;
  }

  submission(leaseId: string, result: Record<string, unknown>, costUsd?: number): ResultSubmission {
    return {
      worker_id: this.id,
      lease_id: leaseId,
      provider: this.localInference ? 'ollama' : 'openai',
      model: this.localInference ? 'qwen3:8b' : 'gpt-test',
      result,
      metrics: {
        duration_ms: 1000,
        input_tokens: 100,
        output_tokens: 20,
        ...(costUsd === undefined ? {} : { cost_usd: costUsd }),
      },
    };
  }

  submit(taskId: string, leaseId: string, result: Record<string, unknown>, costUsd?: number) {
    return this.post(`/tasks/${taskId}/result`, this.submission(leaseId, result, costUsd));
  }
}

export const classification = (field: string, confidence = 0.9) => ({
  field,
  topics: ['protein folding'],
  contains_experiment: true,
  confidence,
});

export function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected a value');
  return value;
}
