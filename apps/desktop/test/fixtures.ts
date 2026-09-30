import type { DaemonStatus, LocalTotals, WorkerConfig } from '@ai-commons/worker';

const zero: LocalTotals = {
  tasks_submitted: 0,
  tasks_failed: 0,
  input_tokens: 0,
  output_tokens: 0,
  local_inference_ms: 0,
  api_cost_usd: 0,
};

export function status(overrides: Partial<DaemonStatus> = {}): DaemonStatus {
  return {
    connection: 'connected',
    worker_id: 'worker_abc123',
    coordinator_url: 'http://localhost:8080',
    mode: 'active',
    idle: false,
    idle_after_minutes: 5,
    current: {
      project_id: 'open-literature-demo',
      project_name: 'Open Literature Demo',
      task_id: 'task_014238',
    },
    today: {
      ...zero,
      tasks_submitted: 238,
      input_tokens: 300_000,
      output_tokens: 18_481,
      api_cost_usd: 0.14,
    },
    month: { ...zero, tasks_submitted: 1_200, api_cost_usd: 2.1 },
    providers: [
      {
        id: 'ollama',
        kind: 'local',
        display_name: 'Ollama (local)',
        enabled: true,
        healthy: true,
        requires_key: false,
        has_key: false,
      },
      {
        id: 'openai',
        kind: 'remote',
        display_name: 'OpenAI API',
        enabled: false,
        healthy: null,
        requires_key: true,
        has_key: false,
      },
    ],
    limits: { daily_usd: 0.25, monthly_usd: 5 },
    ...overrides,
  };
}

/** A status with no task in progress (exactOptionalPropertyTypes forbids `current: undefined`). */
export function idleStatus(overrides: Partial<DaemonStatus> = {}): DaemonStatus {
  const rest = status(overrides);
  delete rest.current;
  return rest;
}

export function config(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    version: 1,
    coordinator_url: 'http://localhost:8080',
    worker_id: 'worker_abc123',
    providers: [
      {
        id: 'ollama',
        kind: 'local',
        enabled: true,
        endpoint: 'http://localhost:11434',
        models: [{ name: 'qwen3:4b', context_window: 40_960 }],
      },
    ],
    limits: { api: { daily_usd: 0, monthly_usd: 0 }, local: { cpu_percent: 25, gpu_percent: 50 } },
    schedule: { mode: 'active' },
    projects: { categories: 'all', allow_remote_for_projects: [] },
    log_level: 'info',
    ...overrides,
  };
}

export function text(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ');
}

export function $<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`No element matches ${selector}`);
  return el;
}

export const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
