import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, saveConfig, type WorkerConfig } from '../src/config.js';
import { WorkerDaemon } from '../src/daemon/daemon.js';
import type { DaemonStatus, ProbeResult } from '../src/daemon/protocol.js';
import { acquireInstanceLock } from '../src/lock.js';
import type { WorkerPaths } from '../src/paths.js';
import { abortableSleep } from '../src/pipeline.js';
import { ProviderRegistry, type ProviderFactory } from '../src/providers/registry.js';
import { MemorySecretStore, secretAccounts } from '../src/secrets.js';
import {
  captureLogger,
  FakeCoordinator,
  FakeProvider,
  leasedTask,
  ok,
  testConfig,
} from './helpers.js';

const API_KEY = 'sk-test-DAEMONSECRET1234567890';
type Message = Record<string, unknown>;

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

class Harness {
  readonly input = new PassThrough();
  readonly output = new PassThrough();
  readonly messages: Message[] = [];
  private raw = '';
  private buffer = '';
  private next = 0;

  constructor() {
    this.output.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      this.raw += text;
      this.buffer += text;
      for (let i = this.buffer.indexOf('\n'); i >= 0; i = this.buffer.indexOf('\n')) {
        this.messages.push(JSON.parse(this.buffer.slice(0, i)) as Message);
        this.buffer = this.buffer.slice(i + 1);
      }
    });
  }

  send(line: string): void {
    this.input.write(`${line}\n`);
  }

  async request(method: string, params?: unknown): Promise<Message> {
    const id = `t${++this.next}`;
    this.send(JSON.stringify(params === undefined ? { id, method } : { id, method, params }));
    await until(() => this.messages.some((m) => m.id === id));
    return this.messages.find((m) => m.id === id) as Message;
  }

  async status(): Promise<DaemonStatus> {
    return (await this.request('getStatus')).result as DaemonStatus;
  }

  responses(): Message[] {
    return this.messages.filter((m) => 'id' in m);
  }

  events(): DaemonStatus[] {
    return this.messages.filter((m) => m.event === 'status').map((m) => m.data as DaemonStatus);
  }

  text(): string {
    return this.raw;
  }
}

interface Started {
  daemon: WorkerDaemon;
  h: Harness;
  paths: WorkerPaths;
  secrets: MemorySecretStore;
  log: ReturnType<typeof captureLogger>;
}

let dir: string;
let coordinator: FakeCoordinator;
let started: Started | undefined;

let openaiFactoryCalls = 0;

async function startDaemon(
  opts: {
    configured?: boolean;
    config?: Partial<WorkerConfig>;
    ollamaFactory?: ProviderFactory;
    openaiFactory?: ProviderFactory;
  } = {},
): Promise<Started> {
  const paths: WorkerPaths = {
    configDir: dir,
    dataDir: dir,
    configFile: join(dir, 'config.json'),
    databaseFile: join(dir, 'worker.db'),
    logFile: join(dir, 'worker.log'),
  };
  if (opts.configured !== false) {
    await saveConfig(paths.configFile, testConfig(coordinator.url, opts.config));
  }
  const secrets = new MemorySecretStore();
  const local = new FakeProvider('ollama', 'local');
  const registry = new ProviderRegistry()
    .register({
      id: 'ollama',
      kind: 'local',
      displayName: 'Ollama (local)',
      requiresKey: false,
      factory: opts.ollamaFactory ?? (async () => local),
    })
    .register({
      id: 'openai',
      kind: 'remote',
      displayName: 'OpenAI API',
      requiresKey: true,
      factory: async (cfg, store) => {
        openaiFactoryCalls++;
        if (opts.openaiFactory) return opts.openaiFactory(cfg, store);
        throw new Error('invalid key sk-live-abcdefghijklmnop');
      },
    });
  const log = captureLogger();
  const h = new Harness();
  const daemon = new WorkerDaemon({
    paths,
    secrets,
    registry,
    logger: log.logger,
    input: h.input,
    output: h.output,
    statusIntervalMs: 50,
    restartDelayMs: 50,
    runnerOverrides: { sleep: (ms, signal) => abortableSleep(Math.min(ms, 20), signal) },
  });
  await daemon.start();
  started = { daemon, h, paths, secrets, log };
  return started;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aic-daemon-'));
  openaiFactoryCalls = 0;
  coordinator = await new FakeCoordinator().start();
});

afterEach(async () => {
  if (started) await started.daemon.shutdown();
  started = undefined;
  await coordinator.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('WorkerDaemon', () => {
  it('reports unconfigured before setup and lists every provider', async () => {
    const { h } = await startDaemon({ configured: false });
    const status = await h.status();
    expect(status).toMatchObject({
      connection: 'unconfigured',
      mode: 'active',
      idle: false,
      idle_after_minutes: 5,
      limits: { daily_usd: 0, monthly_usd: 0 },
    });
    expect(status.providers.map((p) => [p.id, p.enabled, p.requires_key, p.has_key])).toEqual([
      ['ollama', true, false, false],
      ['openai', false, true, false],
    ]);
    expect(coordinator.state.registrations).toBe(0);
  });

  it('survives malformed, oversized, and unknown requests', async () => {
    const { h } = await startDaemon({ configured: false });
    h.send('this is not json');
    h.send(
      JSON.stringify({ id: 'big', method: 'getStatus', params: { pad: 'x'.repeat(1_000_001) } }),
    );
    h.send(JSON.stringify({ id: 'u1', method: 'formatDisk' }));
    await until(() => h.responses().filter((r) => r.ok === false).length === 3);
    expect(h.responses().filter((r) => r.id === null)).toHaveLength(2);
    expect(h.responses().find((r) => r.id === 'u1')).toMatchObject({
      error: { code: 'unknown_method' },
    });
    expect((await h.request('getStatus')).ok).toBe(true);
  });

  it('validates and saves config, then starts contributing', async () => {
    coordinator.state.queue.push(leasedTask(1));
    const { h, paths } = await startDaemon({ configured: false });
    const bad = await h.request('saveConfig', {
      config: { ...testConfig(coordinator.url), coordinator_url: 'ftp://example.org' },
    });
    expect(bad).toMatchObject({ ok: false, error: { code: 'invalid_config' } });

    const good = await h.request('saveConfig', { config: testConfig(coordinator.url) });
    expect(good.ok).toBe(true);
    await until(() => coordinator.state.results.length === 1);
    await until(() => h.events().some((e) => e.today.tasks_submitted === 1));

    const status = await h.status();
    expect(status.connection).toBe('connected');
    expect(status.worker_id).toBe('worker_test1');
    expect(status.providers.find((p) => p.id === 'ollama')?.healthy).toBe(true);
    expect((await loadConfig(paths.configFile)).coordinator_url).toBe(coordinator.url);
  });

  it('emits periodic status events', async () => {
    const { h } = await startDaemon();
    await until(() => h.events().length >= 3);
  });

  it('in idle_only mode contributes only after the shell reports idle', async () => {
    coordinator.state.queue.push(leasedTask(1));
    const { h } = await startDaemon({ config: { schedule: { mode: 'idle_only' } } });
    await until(() => h.events().some((e) => e.connection === 'connected'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(coordinator.state.results).toHaveLength(0);

    expect(await h.request('setIdle', { idle: true })).toMatchObject({
      ok: true,
      result: { idle: true },
    });
    await until(() => coordinator.state.results.length === 1);
    expect((await h.status()).idle).toBe(true);
  });

  it('pauses and resumes to the previous mode', async () => {
    const { h, paths } = await startDaemon({ config: { schedule: { mode: 'idle_only' } } });
    expect((await h.request('setMode', { mode: 'paused' })).result).toEqual({ mode: 'paused' });
    expect((await loadConfig(paths.configFile)).schedule.mode).toBe('paused');
    expect((await h.request('resume')).result).toEqual({ mode: 'idle_only' });
    expect((await loadConfig(paths.configFile)).schedule.mode).toBe('idle_only');
  });

  it('resume leaves a mode that is not paused unchanged', async () => {
    const { h, paths } = await startDaemon({ config: { schedule: { mode: 'idle_only' } } });
    await until(() => h.events().some((e) => e.worker_id === 'worker_test1'));
    const before = readFileSync(paths.configFile, 'utf8');
    expect((await h.request('resume')).result).toEqual({ mode: 'idle_only' });
    expect(readFileSync(paths.configFile, 'utf8')).toBe(before);
  });

  it('keeps the registered worker_id when saved config omits it', async () => {
    const { h, paths } = await startDaemon();
    await until(() => h.events().some((e) => e.connection === 'connected'));
    expect((await loadConfig(paths.configFile)).worker_id).toBe('worker_test1');
    expect((await h.request('saveConfig', { config: testConfig(coordinator.url) })).ok).toBe(true);
    expect((await loadConfig(paths.configFile)).worker_id).toBe('worker_test1');
  });

  it('does not restart the runner when providers only differ in key order', async () => {
    const { h } = await startDaemon();
    await until(() => h.events().some((e) => e.connection === 'connected'));
    const starts = () =>
      coordinator.state.registrations +
      coordinator.state.requests.filter((r) => r.url === '/api/v1/workers/capabilities').length;
    const before = starts();
    const reordered = {
      ...testConfig(coordinator.url),
      providers: [{ models: [{ name: 'test-model' }], enabled: true, kind: 'local', id: 'ollama' }],
    };
    expect((await h.request('saveConfig', { config: reordered })).ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(starts()).toBe(before);
  });

  it('refuses mode changes before setup', async () => {
    const { h } = await startDaemon({ configured: false });
    expect(await h.request('setMode', { mode: 'paused' })).toMatchObject({
      ok: false,
      error: { code: 'bad_request' },
    });
  });

  it('stores API keys only in the keyring and never echoes or logs them', async () => {
    const { h, secrets, log, paths } = await startDaemon();
    expect(await h.request('setKey', { provider: 'openai', key: API_KEY })).toMatchObject({
      ok: true,
      result: { stored: true },
    });
    expect(await secrets.get(secretAccounts.provider('openai'))).toBe(API_KEY);
    expect((await h.status()).providers.find((p) => p.id === 'openai')?.has_key).toBe(true);

    expect(h.text()).not.toContain(API_KEY);
    expect(log.text()).not.toContain(API_KEY);
    expect(readFileSync(paths.configFile, 'utf8')).not.toContain(API_KEY);

    expect((await h.request('deleteKey', { provider: 'openai' })).result).toEqual({
      removed: true,
    });
    expect((await h.status()).providers.find((p) => p.id === 'openai')?.has_key).toBe(false);
    expect(await h.request('setKey', { provider: 'ollama', key: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'bad_request' },
    });
    expect(await h.request('deleteKey', { provider: 'ollama' })).toMatchObject({
      ok: false,
      error: { code: 'bad_request' },
    });
  });

  it('probes providers for models and scrubs failures', async () => {
    const { h } = await startDaemon();
    const found = await h.request('probeProvider', {
      id: 'ollama',
      endpoint: 'http://localhost:11434',
    });
    expect(found.result).toEqual({
      ok: true,
      models: [{ name: 'test-model', context_window: 32_768 }],
    });

    const failed = (await h.request('probeProvider', { id: 'openai' })).result as ProbeResult;
    expect(failed.ok).toBe(false);
    expect(failed.message).toContain('[redacted]');
    expect(failed.message).not.toContain('abcdefghijklmnop');

    expect(
      await h.request('probeProvider', { id: 'ollama', endpoint: 'file:///etc/passwd' }),
    ).toMatchObject({ ok: false, error: { code: 'bad_request' } });
  });

  it('refuses to probe a keyed provider over plain http to a remote host', async () => {
    const { h } = await startDaemon();
    expect(
      await h.request('probeProvider', { id: 'openai', endpoint: 'http://example.org' }),
    ).toMatchObject({ ok: false, error: { code: 'bad_request' } });
    expect(openaiFactoryCalls).toBe(0);
  });

  it('scrubs the stored API key from probe failures', async () => {
    const plainKey = 'plainkey-1234567890abcdef';
    const { h } = await startDaemon({
      openaiFactory: async (_cfg, store) => {
        const key = await store.get(secretAccounts.provider('openai'));
        throw new Error(`provider rejected ${key ?? 'nothing'}`);
      },
    });
    expect((await h.request('setKey', { provider: 'openai', key: plainKey })).ok).toBe(true);
    const failed = (await h.request('probeProvider', { id: 'openai' })).result as ProbeResult;
    expect(failed.ok).toBe(false);
    expect(failed.message).toContain('[redacted]');
    expect(h.text()).not.toContain(plainKey);
  });

  it('stays offline while another worker holds the lock, then takes over', async () => {
    const held = acquireInstanceLock(dir);
    let released = false;
    try {
      const { h } = await startDaemon();
      const status = await h.status();
      expect(status.connection).toBe('offline');
      expect(status.last_error).toMatch(/already running/);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(coordinator.state.registrations).toBe(0);
      expect((await h.request('getStatus')).ok).toBe(true);

      held.release();
      released = true;
      await until(() => h.events().some((e) => e.connection === 'connected'));
      expect(coordinator.state.registrations).toBe(1);
      expect((await h.status()).last_error).toBeUndefined();
    } finally {
      if (!released) held.release();
    }
  });

  it('does not start the runner once shutdown has begun during init', async () => {
    const gate: { open?: () => void } = {};
    const opened = new Promise<void>((resolve) => {
      gate.open = resolve;
    });
    let entered = false;
    const local = new FakeProvider('ollama', 'local');
    const { h, daemon } = await startDaemon({
      ollamaFactory: async () => {
        entered = true;
        await opened;
        return local;
      },
    });
    await until(() => entered);
    expect((await h.request('shutdown')).result).toEqual({ stopping: true });
    gate.open?.();
    await daemon.finished();
    expect(coordinator.state.heartbeats).toHaveLength(0);
    expect(coordinator.state.requests.some((r) => r.url === '/api/v1/tasks/lease')).toBe(false);
  });

  it('stdin EOF after a shutdown request still lets the current task finish', async () => {
    coordinator.state.queue.push(leasedTask(1));
    const slow = new FakeProvider('ollama', 'local', [
      async (req) => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return ok({ field: 'biology', confidence: 0.9 })(req);
      },
    ]);
    const { h, daemon } = await startDaemon({ ollamaFactory: async () => slow });
    await until(() => slow.calls.length === 1);
    expect((await h.request('shutdown')).result).toEqual({ stopping: true });
    h.input.end();
    await daemon.finished();
    expect(coordinator.state.results).toHaveLength(1);
    expect(coordinator.state.fails).toHaveLength(0);
  });

  it('shuts down when stdout fails', async () => {
    const { h, daemon } = await startDaemon();
    await until(() => h.events().some((e) => e.connection === 'connected'));
    h.output.destroy(new Error('EPIPE'));
    await daemon.finished();
  });

  it('drains and finishes on a shutdown request', async () => {
    const { h, daemon } = await startDaemon();
    await until(() => h.events().some((e) => e.connection === 'connected'));
    expect((await h.request('shutdown')).result).toEqual({ stopping: true });
    await daemon.finished();
  });

  it('shuts down when stdin closes', async () => {
    const { h, daemon } = await startDaemon();
    h.input.end();
    await daemon.finished();
  });
});
