import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli, type CliContext } from '../src/commands.js';
import { loadConfig } from '../src/config.js';
import { MemorySecretStore, secretAccounts } from '../src/secrets.js';
import { captureLogger, FakeCoordinator, FakeProvider, leasedTask } from './helpers.js';
import { ProviderRegistry } from '../src/providers/registry.js';

let dir: string;
let secrets: MemorySecretStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aic-cli-'));
  secrets = new MemorySecretStore();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function ctx(stdinText = '', extra: Partial<CliContext> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const context: CliContext = {
    paths: {
      configDir: dir,
      dataDir: dir,
      configFile: join(dir, 'config.json'),
      databaseFile: join(dir, 'worker.db'),
      logFile: join(dir, 'worker.log'),
    },
    io: {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      stdin: Readable.from([stdinText]),
      stdout: new PassThrough(),
    },
    secrets,
    onSignal: () => undefined,
    ...extra,
  };
  return { context, out, err };
}

describe('aicommons CLI', () => {
  it('configures non-interactively with flags', async () => {
    const { context, out } = ctx();
    const code = await runCli(
      [
        'configure',
        '--coordinator-url',
        'https://coordinator.example.org',
        '--daily-usd',
        '0.25',
        '--monthly-usd',
        '5',
        '--enable',
        'openai',
        '--models',
        'openai=gpt-test',
        '--models',
        'ollama=qwen3:8b',
        '--categories',
        'science,medicine',
        '--allow-remote',
        'open-literature-demo',
      ],
      context,
    );
    expect(code).toBe(0);
    const config = await loadConfig(context.paths.configFile);
    expect(config.limits.api).toEqual({ daily_usd: 0.25, monthly_usd: 5 });
    expect(config.providers.find((p) => p.id === 'openai')).toMatchObject({
      kind: 'remote',
      enabled: true,
      models: [{ name: 'gpt-test' }],
    });
    expect(config.projects).toEqual({
      categories: ['science', 'medicine'],
      allow_remote_for_projects: ['open-literature-demo'],
    });
    expect(out.join('\n')).toContain('remote providers receive the full task input');
    expect(out.join('\n')).toContain('set-key openai');
  });

  it('rejects invalid configuration', async () => {
    const { context, err } = ctx();
    expect(
      await runCli(['configure', '--coordinator-url', 'http://evil.example.org'], context),
    ).toBe(1);
    expect(err.join()).toMatch(/https/);
    expect(await runCli(['configure', '--categories', 'crypto'], ctx().context)).toBe(1);
  });

  it('pauses and resumes', async () => {
    const { context } = ctx();
    await runCli(['pause'], context);
    expect((await loadConfig(context.paths.configFile)).schedule.mode).toBe('paused');
    await runCli(['resume'], context);
    expect((await loadConfig(context.paths.configFile)).schedule.mode).toBe('active');
  });

  it('stores API keys from stdin in the secret store only', async () => {
    const key = 'sk-proj-THISISAVERYSECRETKEY';
    const { context, out } = ctx(`${key}\n`);
    expect(await runCli(['set-key', 'openai'], context)).toBe(0);
    expect(await secrets.get(secretAccounts.provider('openai'))).toBe(key);
    expect(out.join()).not.toContain(key);
    await runCli(['configure', '--enable', 'openai', '--models', 'openai=gpt-test'], ctx().context);
    expect(readFileSync(context.paths.configFile, 'utf8')).not.toContain(key);
  });

  it('refuses keys for local providers and keys passed as arguments', async () => {
    expect(await runCli(['set-key', 'ollama'], ctx('whatever\n').context)).toBe(2);
    expect(await runCli(['set-key', 'openai', 'sk-inline-key-123'], ctx().context)).toBe(2);
  });

  it('shows status and usage', async () => {
    const { context, out } = ctx();
    expect(await runCli(['status'], context)).toBe(0);
    expect(out.join('\n')).toContain('Daily API limit');
    expect(await runCli(['usage'], context)).toBe(0);
    expect(out.join('\n')).toContain('API contribution');
  });

  it('inspects a project and runs start end-to-end', async () => {
    const coordinator = await new FakeCoordinator(undefined, [leasedTask(1)]).start();
    try {
      await runCli(
        ['configure', '--coordinator-url', coordinator.url, '--models', 'ollama=test-model'],
        ctx().context,
      );
      const { context, out } = ctx();
      expect(await runCli(['inspect', 'open-literature-demo'], context)).toBe(0);
      const text = out.join('\n');
      expect(text).toContain('Title: {{title}}');
      expect(text).toContain('"confidence"');
      expect(text).toContain('Local models only     no');

      const local = new FakeProvider('ollama', 'local');
      const registry = new ProviderRegistry().register({
        id: 'ollama',
        kind: 'local',
        displayName: 'Ollama',
        requiresKey: false,
        factory: async () => local,
      });
      const run = ctx('', { registry, logger: captureLogger().logger });
      expect(await runCli(['start', '--max-tasks', '1'], run.context)).toBe(0);
      expect(coordinator.state.results).toHaveLength(1);

      const usage = ctx();
      await runCli(['usage'], usage.context);
      expect(usage.out.join('\n')).toMatch(/Tasks submitted\s+1/);
    } finally {
      await coordinator.stop();
    }
  });
});
