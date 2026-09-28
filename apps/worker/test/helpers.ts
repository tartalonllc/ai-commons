import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import type {
  JsonObject,
  LeasedTask,
  Project,
  ProviderKind,
  ResultSubmission,
  TaskFailRequest,
} from '@ai-commons/protocol';
import {
  ProviderError,
  type AIProvider,
  type CostEstimate,
  type InferenceRequest,
  type InferenceResult,
  type ModelInfo,
  type ProviderHealth,
} from '@ai-commons/provider-core';
import { createLogger, type Logger } from '../src/logger.js';
import { defaultConfig, type WorkerConfig } from '../src/config.js';

export const WORKER_SECRET = 'wsec_' + 'Z'.repeat(40);

export function testProject(overrides: Partial<Project> = {}): Project {
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
    output_schema: {
      type: 'object',
      required: ['field', 'confidence'],
      properties: {
        field: { type: 'string' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
      additionalProperties: false,
    },
    prompt: { system: 'Classify. JSON only.', user: 'Title: {{title}}\nAbstract: {{abstract}}' },
    requirements: {
      capability: 'text_generation',
      minimum_context_window: 4096,
      max_output_tokens: 256,
      local_models_only: false,
    },
    validation: { mode: 'schema', replication_factor: 1 },
    status: 'active',
    created_at: '2026-09-28T00:00:00.000Z',
    updated_at: '2026-09-28T00:00:00.000Z',
    ...overrides,
  };
}

export interface FakeCoordinatorState {
  project: Project;
  queue: LeasedTask[];
  registrations: number;
  heartbeats: unknown[];
  results: { taskId: string; body: ResultSubmission; auth: string | undefined }[];
  fails: { taskId: string; body: TaskFailRequest }[];
  extends: string[];
  requests: { method: string; url: string; body: string; auth: string | undefined }[];
}

export function leasedTask(n: number, overrides: Partial<LeasedTask> = {}): LeasedTask {
  const project = testProject();
  return {
    id: `task_${String(n).padStart(6, '0')}`,
    lease_id: `lease_${String(n).padStart(10, '0')}`,
    project_id: project.id,
    project_version: project.version,
    payload: { title: `Paper ${n}`, abstract: `Abstract text ${n}` },
    requirements: project.requirements,
    expires_at: new Date(Date.now() + 900_000).toISOString(),
    ...overrides,
  };
}

export class FakeCoordinator {
  server: Server;
  url = '';
  state: FakeCoordinatorState;

  constructor(project = testProject(), queue: LeasedTask[] = []) {
    this.state = {
      project,
      queue,
      registrations: 0,
      heartbeats: [],
      results: [],
      fails: [],
      extends: [],
      requests: [],
    };
    this.server = createServer((req, res) => void this.handle(req, res));
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    const url = req.url ?? '';
    const auth = req.headers.authorization;
    this.state.requests.push({ method: req.method ?? '', url, body, auth });
    const json = (status: number, data?: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(data === undefined ? '' : JSON.stringify(data));
    };
    const authed = auth === `Bearer ${WORKER_SECRET}`;
    const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};

    if (url === '/api/v1/workers/register') {
      this.state.registrations++;
      return json(200, {
        worker_id: 'worker_test1',
        worker_secret: WORKER_SECRET,
        heartbeat_interval_ms: 60_000,
        lease_duration_ms: 900_000,
      });
    }
    if (url.startsWith('/api/v1/projects/')) {
      return json(200, this.state.project);
    }
    if (!authed) return json(401, { error: { code: 'unauthorized', message: 'bad token' } });

    if (url === '/api/v1/workers/capabilities') return json(204);
    if (url === '/api/v1/workers/heartbeat') {
      this.state.heartbeats.push(parsed);
      return json(200, { server_time: new Date().toISOString() });
    }
    if (url === '/api/v1/tasks/lease') {
      const task = this.state.queue.shift();
      return json(200, task ? { task } : { task: null, retry_after_ms: 10 });
    }
    const m = /^\/api\/v1\/tasks\/([^/]+)\/(result|fail|extend)$/.exec(url);
    if (m) {
      const taskId = decodeURIComponent(m[1] as string);
      if (m[2] === 'result') {
        this.state.results.push({ taskId, body: parsed as unknown as ResultSubmission, auth });
        return json(200, { status: 'accepted' });
      }
      if (m[2] === 'fail') {
        this.state.fails.push({ taskId, body: parsed as unknown as TaskFailRequest });
        return json(204);
      }
      this.state.extends.push(taskId);
      return json(200, {
        lease_id: parsed.lease_id,
        expires_at: new Date(Date.now() + 900_000).toISOString(),
      });
    }
    return json(404, { error: { code: 'not_found', message: 'no route' } });
  }
}

export type Behavior = (req: InferenceRequest) => Promise<InferenceResult> | InferenceResult;

export class FakeProvider implements AIProvider {
  calls: InferenceRequest[] = [];
  estimates = 0;
  private behaviors: Behavior[];

  constructor(
    readonly id: string,
    readonly kind: ProviderKind,
    behaviors: Behavior[] = [],
    readonly options: {
      models?: ModelInfo[];
      costPerCall?: number;
      estimateUsd?: number;
      estimateThrows?: boolean;
    } = {},
  ) {
    this.behaviors = behaviors;
  }

  async getModels(): Promise<ModelInfo[]> {
    return this.options.models ?? [{ name: 'test-model', context_window: 32_768 }];
  }

  async estimateCost(request: InferenceRequest): Promise<CostEstimate> {
    this.estimates++;
    if (this.options.estimateThrows) throw new Error('no pricing');
    return {
      max_usd: this.options.estimateUsd ?? 0.01,
      estimated_input_tokens: 100,
      max_output_tokens: request.max_output_tokens,
    };
  }

  async execute(request: InferenceRequest): Promise<InferenceResult> {
    this.calls.push(request);
    const behavior = this.behaviors.shift() ?? ok({ field: 'biology', confidence: 0.9 });
    const result = await behavior(request);
    return this.kind === 'remote' && this.options.costPerCall !== undefined
      ? { ...result, cost_usd: this.options.costPerCall }
      : result;
  }

  async healthCheck(): Promise<ProviderHealth> {
    return { ok: true };
  }
}

export const ok =
  (output: JsonObject): Behavior =>
  (req) => ({ output, model: req.model, duration_ms: 5, input_tokens: 50, output_tokens: 10 });

export const fail =
  (code: ConstructorParameters<typeof ProviderError>[0], message: string = code): Behavior =>
  () => {
    throw new ProviderError(code, message);
  };

export function captureLogger(): { logger: Logger; text: () => string } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString('utf8'));
      cb();
    },
  });
  return { logger: createLogger('debug', stream), text: () => lines.join('') };
}

export function testConfig(
  coordinatorUrl: string,
  overrides: Partial<WorkerConfig> = {},
): WorkerConfig {
  const base = defaultConfig();
  return {
    ...base,
    coordinator_url: coordinatorUrl,
    providers: [{ id: 'ollama', kind: 'local', enabled: true, models: [{ name: 'test-model' }] }],
    ...overrides,
  };
}
