import type { NetworkSummary, Project } from '@ai-commons/protocol';

export const NOW = new Date('2026-09-28T12:00:00.000Z');

export function network(overrides: Partial<NetworkSummary> = {}): NetworkSummary {
  return {
    network: {
      connected_workers: 2,
      active_workers: 1,
      tasks_waiting: 12,
      tasks_processing: 3,
      tasks_completed: 8214,
      tasks_failed: 4,
    },
    compute: {
      input_tokens: 14_000_000,
      output_tokens: 800_000,
      local_inference_hours: 63,
      api_cost_usd: 7.84,
      ai_compute_units: 7840,
    },
    projects: [
      {
        id: 'open-literature-demo',
        name: 'Open Literature Classification',
        tasks_total: 1000,
        tasks_completed: 731,
        progress: 0.731,
        workers: 2,
        tokens_processed: 318_481,
        local_inference_hours: 2.5,
        api_cost_usd: 0.14,
      },
    ],
    workers: [
      {
        worker_id: 'worker_abcde12345',
        status: 'available',
        tasks_completed: 238,
        last_seen: '2026-09-28T11:59:30.000Z',
      },
      {
        worker_id: 'worker_zyxwv98765',
        status: 'busy',
        tasks_completed: 12,
        last_seen: '2026-09-28T11:00:00.000Z',
      },
    ],
    generated_at: NOW.toISOString(),
    ...overrides,
  };
}

export function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'open-literature-demo',
    name: 'Open Literature Classification',
    description: 'Classify 1,000 scientific abstracts by field and topic.',
    version: '1.0.0',
    category: 'science',
    input_schema: {
      type: 'object',
      required: ['title', 'abstract'],
      properties: { title: { type: 'string' }, abstract: { type: 'string' } },
    },
    output_schema: {
      type: 'object',
      required: ['field'],
      properties: { field: { type: 'string' } },
    },
    prompt: { system: 'Classify. JSON only.', user: 'Title: {{title}}\n\n{{abstract}}' },
    requirements: {
      capability: 'text_generation',
      minimum_context_window: 8192,
      max_output_tokens: 300,
      local_models_only: false,
    },
    validation: { mode: 'consensus', replication_factor: 2, consensus_fields: ['field'] },
    status: 'active',
    created_at: '2026-09-27T12:00:00.000Z',
    updated_at: '2026-09-27T12:00:00.000Z',
    ...overrides,
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
