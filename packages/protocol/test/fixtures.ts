import type {
  LeaseRequest,
  LeaseResponse,
  Project,
  ProjectDefinition,
  RegisterWorkerRequest,
  RegisterWorkerResponse,
  ResultSubmission,
  TaskFailRequest,
} from '../src/index.js';

export const projectDefinition: ProjectDefinition = {
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
    required: ['field', 'topics', 'contains_experiment', 'confidence'],
    properties: {
      field: { type: 'string' },
      topics: { type: 'array', items: { type: 'string' } },
      contains_experiment: { type: 'boolean' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
  },
  prompt: {
    system: 'You classify scientific abstracts. Respond with JSON only.',
    user: 'Title: {{title}}\n\nAbstract: {{abstract}}',
  },
  requirements: {
    capability: 'text_generation',
    minimum_context_window: 8192,
    max_output_tokens: 512,
    local_models_only: false,
  },
  validation: { mode: 'consensus', replication_factor: 2, consensus_fields: ['field'] },
};

export const project: Project = {
  ...projectDefinition,
  status: 'active',
  created_at: '2026-09-28T12:00:00.000Z',
  updated_at: '2026-09-28T12:00:00.000Z',
};

export const registerRequest: RegisterWorkerRequest = {
  protocol_version: '0.1.0',
  capabilities: {
    platform: 'windows',
    client_version: '0.1.0',
    providers: [
      { provider: 'ollama', kind: 'local', models: [{ name: 'qwen3:8b', context_window: 32768 }] },
      { provider: 'openai', kind: 'remote', models: [{ name: 'configured-model' }] },
    ],
  },
};

export const registerResponse: RegisterWorkerResponse = {
  worker_id: 'worker_f4e82',
  worker_secret: 'x'.repeat(43),
  heartbeat_interval_ms: 60_000,
  lease_duration_ms: 900_000,
};

export const leaseRequest: LeaseRequest = {
  worker_id: 'worker_f4e82',
  capabilities: { text_generation: true, local_inference: true, max_context_window: 32768 },
  categories: ['science', 'medicine'],
};

export const leaseResponse: LeaseResponse = {
  task: {
    id: 'task_000042',
    lease_id: 'lease_01JABC123XYZ',
    project_id: 'open-literature-demo',
    project_version: '1.0.0',
    payload: { title: 'Protein Folding Study', abstract: 'We simulate...' },
    requirements: projectDefinition.requirements,
    expires_at: '2026-09-28T12:15:00.000Z',
  },
};

export const resultSubmission: ResultSubmission = {
  worker_id: 'worker_f4e82',
  lease_id: 'lease_01JABC123XYZ',
  provider: 'ollama',
  model: 'qwen3:8b',
  result: {
    field: 'biology',
    topics: ['protein folding'],
    contains_experiment: true,
    confidence: 0.91,
  },
  metrics: { duration_ms: 3850, input_tokens: 726, output_tokens: 112 },
};

export const failRequest: TaskFailRequest = {
  worker_id: 'worker_f4e82',
  lease_id: 'lease_01JABC123XYZ',
  reason: 'provider_error',
  message: 'connection refused',
  attempts: 3,
};
