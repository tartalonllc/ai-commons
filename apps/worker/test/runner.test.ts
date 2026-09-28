import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, saveConfig, type WorkerConfig } from '../src/config.js';
import { WorkerDatabase } from '../src/db.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { WorkerRunner } from '../src/runner.js';
import { MemorySecretStore, secretAccounts } from '../src/secrets.js';
import {
  captureLogger,
  fail,
  FakeCoordinator,
  FakeProvider,
  leasedTask,
  ok,
  testConfig,
  testProject,
  WORKER_SECRET,
} from './helpers.js';

const API_KEY = 'sk-test-SUPERSECRETKEY1234567890';

let dir: string;
let coordinator: FakeCoordinator;
let db: WorkerDatabase;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aic-worker-'));
  coordinator = await new FakeCoordinator().start();
  db = new WorkerDatabase(join(dir, 'worker.db'));
});

afterEach(async () => {
  db.close();
  await coordinator.stop();
  rmSync(dir, { recursive: true, force: true });
});

interface Setup {
  local?: FakeProvider;
  remote?: FakeProvider;
  config?: Partial<WorkerConfig>;
  secrets?: MemorySecretStore;
  onSleep?: (ms: number, configFile: string) => Promise<void>;
}

async function makeRunner(setup: Setup) {
  const secrets = setup.secrets ?? new MemorySecretStore();
  await secrets.set(secretAccounts.provider('openai'), API_KEY);
  const registry = new ProviderRegistry();
  const providers: WorkerConfig['providers'] = [];
  if (setup.local) {
    const p = setup.local;
    registry.register({
      id: 'ollama',
      kind: 'local',
      displayName: 'Ollama',
      requiresKey: false,
      factory: async () => p,
    });
    providers.push({
      id: 'ollama',
      kind: 'local',
      enabled: true,
      models: [{ name: 'test-model' }],
    });
  }
  if (setup.remote) {
    const p = setup.remote;
    registry.register({
      id: 'openai',
      kind: 'remote',
      displayName: 'OpenAI',
      requiresKey: true,
      factory: async (_cfg, s) => {
        expect(await s.get(secretAccounts.provider('openai'))).toBe(API_KEY);
        return p;
      },
    });
    providers.push({
      id: 'openai',
      kind: 'remote',
      enabled: true,
      models: [{ name: 'test-model', context_window: 128_000 }],
    });
  }
  const configFile = join(dir, 'config.json');
  await saveConfig(configFile, testConfig(coordinator.url, { providers, ...setup.config }));
  const log = captureLogger();
  const delays: number[] = [];
  const runner = new WorkerRunner({
    db,
    secrets,
    registry,
    logger: log.logger,
    loadConfig: () => loadConfig(configFile),
    saveConfig: (c) => saveConfig(configFile, c),
    sleep: async (ms) => {
      delays.push(ms);
      await setup.onSleep?.(ms, configFile);
    },
  });
  await runner.init();
  return { runner, log, delays, configFile, secrets };
}

describe('WorkerRunner pipeline', () => {
  it('registers, leases, executes locally, validates, and submits', async () => {
    coordinator.state.queue.push(leasedTask(1));
    const local = new FakeProvider('ollama', 'local');
    const { runner, configFile } = await makeRunner({ local });
    await runner.run({ maxTasks: 1 });

    expect(coordinator.state.registrations).toBe(1);
    expect(local.calls[0]?.user).toBe('Title: Paper 1\nAbstract: Abstract text 1');
    expect(local.calls[0]?.max_output_tokens).toBe(256);
    expect(coordinator.state.results).toHaveLength(1);
    const submitted = coordinator.state.results[0];
    expect(submitted?.auth).toBe(`Bearer ${WORKER_SECRET}`);
    expect(submitted?.body).toMatchObject({
      worker_id: 'worker_test1',
      lease_id: 'lease_0000000001',
      provider: 'ollama',
      model: 'test-model',
      result: { field: 'biology', confidence: 0.9 },
      metrics: { input_tokens: 50, output_tokens: 10 },
    });
    expect(submitted?.body.metrics.cost_usd).toBeUndefined();
    expect(coordinator.state.heartbeats.length).toBeGreaterThanOrEqual(1);
    expect((await loadConfig(configFile)).worker_id).toBe('worker_test1');
    expect(db.get(`SELECT status FROM tasks`)?.status).toBe('submitted');
  });

  it('reuses stored credentials instead of re-registering', async () => {
    const local = new FakeProvider('ollama', 'local');
    const secrets = new MemorySecretStore();
    await makeRunner({ local, secrets });
    await makeRunner({ local, secrets });
    expect(coordinator.state.registrations).toBe(1);
  });

  it('retries retryable errors with 5s then 30s delays and then succeeds', async () => {
    coordinator.state.queue.push(leasedTask(1));
    const local = new FakeProvider('ollama', 'local', [fail('unavailable'), fail('timeout')]);
    const { runner, delays } = await makeRunner({ local });
    await runner.run({ maxTasks: 1 });
    expect(local.calls).toHaveLength(3);
    expect(delays.slice(0, 2)).toEqual([5_000, 30_000]);
    expect(coordinator.state.results).toHaveLength(1);
  });

  it('reports failure after three attempts', async () => {
    coordinator.state.queue.push(leasedTask(1));
    const local = new FakeProvider('ollama', 'local', [
      fail('unavailable'),
      fail('unavailable'),
      fail('unavailable'),
    ]);
    const { runner } = await makeRunner({ local });
    await runner.run({ maxTasks: 1 });
    expect(local.calls).toHaveLength(3);
    expect(coordinator.state.results).toHaveLength(0);
    expect(coordinator.state.fails[0]?.body).toMatchObject({
      reason: 'provider_error',
      attempts: 3,
    });
  });

  it('does not retry non-retryable errors', async () => {
    coordinator.state.queue.push(leasedTask(1));
    const local = new FakeProvider('ollama', 'local', [fail('bad_request')]);
    const { runner } = await makeRunner({ local });
    await runner.run({ maxTasks: 1 });
    expect(local.calls).toHaveLength(1);
    expect(coordinator.state.fails[0]?.body).toMatchObject({
      reason: 'provider_error',
      attempts: 1,
    });
  });

  it('treats schema-invalid output as retryable, then fails with invalid_output', async () => {
    coordinator.state.queue.push(leasedTask(1));
    const bad = ok({ field: 'biology', confidence: 7 });
    const local = new FakeProvider('ollama', 'local', [bad, bad, bad]);
    const { runner } = await makeRunner({ local });
    await runner.run({ maxTasks: 1 });
    expect(local.calls).toHaveLength(3);
    expect(coordinator.state.results).toHaveLength(0);
    expect(coordinator.state.fails[0]?.body).toMatchObject({
      reason: 'invalid_output',
      attempts: 3,
    });
  });

  it('never sends local_models_only tasks to a remote provider', async () => {
    coordinator.state.project = testProject({
      requirements: { ...testProject().requirements, local_models_only: true },
    });
    coordinator.state.queue.push(
      leasedTask(1, { requirements: coordinator.state.project.requirements }),
    );
    const remote = new FakeProvider('openai', 'remote', [], { costPerCall: 0.001 });
    const { runner } = await makeRunner({
      remote,
      config: {
        limits: {
          api: { daily_usd: 1, monthly_usd: 5 },
          local: { cpu_percent: 25, gpu_percent: 50 },
        },
        projects: { categories: 'all', allow_remote_for_projects: 'all' },
      },
    });
    await runner.run({ maxTasks: 1 });
    expect(remote.calls).toHaveLength(0);
    expect(remote.estimates).toBe(0);
    expect(coordinator.state.fails[0]?.body.reason).toBe('other');
  });

  it('prefers local providers when both are available', async () => {
    coordinator.state.queue.push(leasedTask(1));
    const local = new FakeProvider('ollama', 'local');
    const remote = new FakeProvider('openai', 'remote', [], { costPerCall: 0.001 });
    const { runner } = await makeRunner({
      local,
      remote,
      config: {
        limits: {
          api: { daily_usd: 1, monthly_usd: 5 },
          local: { cpu_percent: 25, gpu_percent: 50 },
        },
        projects: { categories: 'all', allow_remote_for_projects: 'all' },
      },
    });
    await runner.run({ maxTasks: 1 });
    expect(local.calls).toHaveLength(1);
    expect(remote.calls).toHaveLength(0);
  });

  it('does not use remote providers for projects the volunteer has not allowed', async () => {
    coordinator.state.queue.push(leasedTask(1));
    const remote = new FakeProvider('openai', 'remote', [], { costPerCall: 0.001 });
    const { runner } = await makeRunner({
      remote,
      config: {
        limits: {
          api: { daily_usd: 1, monthly_usd: 5 },
          local: { cpu_percent: 25, gpu_percent: 50 },
        },
        projects: { categories: 'all', allow_remote_for_projects: ['some-other-project'] },
      },
    });
    await runner.run({ maxTasks: 1 });
    expect(remote.calls).toHaveLength(0);
  });

  it('executes on a remote provider within budget and reports cost', async () => {
    coordinator.state.queue.push(leasedTask(1));
    const remote = new FakeProvider('openai', 'remote', [], {
      costPerCall: 0.004,
      estimateUsd: 0.01,
    });
    const { runner } = await makeRunner({
      remote,
      config: {
        limits: {
          api: { daily_usd: 1, monthly_usd: 5 },
          local: { cpu_percent: 25, gpu_percent: 50 },
        },
        projects: { categories: 'all', allow_remote_for_projects: 'all' },
      },
    });
    await runner.run({ maxTasks: 1 });
    expect(coordinator.state.results[0]?.body.metrics.cost_usd).toBe(0.004);
    expect(runner.budgetLimiter.spent().day_usd).toBeCloseTo(0.004);
  });

  it('refuses remote work that would exceed the budget without calling the provider', async () => {
    coordinator.state.queue.push(leasedTask(1), leasedTask(2));
    const remote = new FakeProvider('openai', 'remote', [], { costPerCall: 0.2, estimateUsd: 0.2 });
    const { runner } = await makeRunner({
      remote,
      config: {
        limits: {
          api: { daily_usd: 0.25, monthly_usd: 5 },
          local: { cpu_percent: 25, gpu_percent: 50 },
        },
        projects: { categories: 'all', allow_remote_for_projects: 'all' },
      },
    });
    await runner.run({ maxTasks: 2 });
    expect(remote.calls).toHaveLength(1);
    expect(coordinator.state.results).toHaveLength(1);
    expect(coordinator.state.fails[0]?.body.reason).toBe('budget_exceeded');
    expect(runner.budgetLimiter.spent().day_usd).toBeLessThanOrEqual(0.25);
  });

  it('refuses remote calls when cost cannot be estimated', async () => {
    coordinator.state.queue.push(leasedTask(1));
    const remote = new FakeProvider('openai', 'remote', [], { estimateThrows: true });
    const { runner } = await makeRunner({
      remote,
      config: {
        limits: {
          api: { daily_usd: 1, monthly_usd: 5 },
          local: { cpu_percent: 25, gpu_percent: 50 },
        },
        projects: { categories: 'all', allow_remote_for_projects: 'all' },
      },
    });
    await runner.run({ maxTasks: 1 });
    expect(remote.calls).toHaveLength(0);
    expect(coordinator.state.fails[0]?.body.reason).toBe('budget_exceeded');
  });

  it('rejects payloads that do not match the project input schema', async () => {
    coordinator.state.queue.push(leasedTask(1, { payload: { title: 5 } }));
    const local = new FakeProvider('ollama', 'local');
    const { runner } = await makeRunner({ local });
    await runner.run({ maxTasks: 1 });
    expect(local.calls).toHaveLength(0);
    expect(coordinator.state.fails[0]?.body.reason).toBe('other');
  });

  it('refuses project schemas with remote $ref', async () => {
    coordinator.state.project = testProject({
      output_schema: { type: 'object', properties: { a: { $ref: 'https://evil.example/s.json' } } },
    });
    coordinator.state.queue.push(leasedTask(1));
    const local = new FakeProvider('ollama', 'local');
    const { runner } = await makeRunner({ local });
    await runner.run({ maxTasks: 1 });
    expect(local.calls).toHaveLength(0);
  });

  it('does not lease while paused and resumes when unpaused', async () => {
    coordinator.state.queue.push(leasedTask(1));
    const local = new FakeProvider('ollama', 'local');
    let pausedPolls = 0;
    const { runner } = await makeRunner({
      local,
      config: { schedule: { mode: 'paused' } },
      onSleep: async (ms, file) => {
        if (ms !== 5_000) return;
        pausedPolls++;
        expect(coordinator.state.queue).toHaveLength(1);
        if (pausedPolls === 2) {
          const c = await loadConfig(file);
          c.schedule.mode = 'active';
          await saveConfig(file, c);
        }
      },
    });
    await runner.run({ maxTasks: 1 });
    expect(pausedPolls).toBe(2);
    expect(coordinator.state.heartbeats[0]).toMatchObject({ status: 'paused' });
    expect(coordinator.state.results).toHaveLength(1);
  });

  it('never writes secrets to logs, config, database, or failure messages', async () => {
    coordinator.state.queue.push(leasedTask(1));
    const remote = new FakeProvider('openai', 'remote', [fail('auth', `invalid key ${API_KEY}`)], {
      costPerCall: 0.001,
    });
    const { runner, log, configFile } = await makeRunner({
      remote,
      config: {
        limits: {
          api: { daily_usd: 1, monthly_usd: 5 },
          local: { cpu_percent: 25, gpu_percent: 50 },
        },
        projects: { categories: 'all', allow_remote_for_projects: 'all' },
      },
    });
    await runner.run({ maxTasks: 1 });
    db.close();

    const failure = coordinator.state.fails[0]?.body.message ?? '';
    expect(failure).toContain('[redacted]');
    const haystacks = [
      log.text(),
      readFileSync(configFile, 'utf8'),
      readFileSync(join(dir, 'worker.db')).toString('latin1'),
      JSON.stringify(coordinator.state.fails),
      coordinator.state.requests.map((r) => r.body).join('\n'),
    ];
    for (const text of haystacks) {
      expect(text).not.toContain(API_KEY);
      expect(text).not.toContain(WORKER_SECRET);
    }
    // Payload text is not logged either.
    expect(log.text()).not.toContain('Abstract text 1');
    db = new WorkerDatabase(join(dir, 'worker.db'));
  });
});
