import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConfigError,
  defaultConfig,
  loadConfig,
  saveConfig,
  validateConfig,
  validateCoordinatorUrl,
} from '../src/config.js';
import { CoordinatorClient, CoordinatorError, type FetchFn } from '../src/coordinator-client.js';
import { scrubSecrets } from '../src/logger.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe('config', () => {
  it('returns defaults when no file exists and round-trips through disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aic-cfg-'));
    dirs.push(dir);
    const file = join(dir, 'nested', 'config.json');
    const config = await loadConfig(file);
    expect(config).toEqual(defaultConfig());
    config.limits.api = { daily_usd: 0.25, monthly_usd: 5 };
    await saveConfig(file, config);
    expect(await loadConfig(file)).toEqual(config);
  });

  it('rejects secret-looking or unknown fields', () => {
    expect(() => validateConfig({ ...defaultConfig(), api_key: 'sk-123' })).toThrow(ConfigError);
    const cfg = defaultConfig();
    expect(() =>
      validateConfig({ ...cfg, providers: [{ ...cfg.providers[0], api_key: 'sk-123' }] }),
    ).toThrow(ConfigError);
  });

  it('requires daily <= monthly limits', () => {
    const cfg = defaultConfig();
    cfg.limits.api = { daily_usd: 10, monthly_usd: 5 };
    expect(() => validateConfig(cfg)).toThrow(/monthly/);
  });

  it('requires https except for localhost', () => {
    expect(() => validateCoordinatorUrl('http://coordinator.example.org')).toThrow(ConfigError);
    expect(() => validateCoordinatorUrl('https://user:pw@coordinator.example.org')).toThrow(
      ConfigError,
    );
    expect(validateCoordinatorUrl('https://coordinator.example.org').origin).toBe(
      'https://coordinator.example.org',
    );
    expect(validateCoordinatorUrl('http://127.0.0.1:3000').port).toBe('3000');
    expect(validateCoordinatorUrl('http://localhost').hostname).toBe('localhost');
  });
});

describe('CoordinatorClient', () => {
  const respond =
    (status: number, body: unknown, headers: Record<string, string> = {}): FetchFn =>
    async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      });

  it('sends bearer auth to the /api/v1 prefix', async () => {
    let seen: { url: string; auth: string | null } | undefined;
    const client = new CoordinatorClient({
      baseUrl: 'https://coordinator.example.org/',
      credentials: () => ({ workerId: 'worker_abcde', secret: 's3cret' }),
      fetch: async (url, init) => {
        seen = { url, auth: new Headers(init.headers).get('authorization') };
        return new Response(JSON.stringify({ task: null, retry_after_ms: 5 }), { status: 200 });
      },
    });
    await client.lease({
      worker_id: 'worker_abcde',
      capabilities: { text_generation: true, local_inference: true, max_context_window: 8192 },
    });
    expect(seen).toEqual({
      url: 'https://coordinator.example.org/api/v1/tasks/lease',
      auth: 'Bearer s3cret',
    });
  });

  it('rejects responses that fail schema validation', async () => {
    const client = new CoordinatorClient({
      baseUrl: 'http://localhost:3000',
      credentials: () => ({ workerId: 'worker_abcde', secret: 's' }),
      fetch: respond(200, { task: { id: 'x' } }),
    });
    await expect(
      client.lease({
        worker_id: 'worker_abcde',
        capabilities: { text_generation: true, local_inference: true, max_context_window: 8192 },
      }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('maps API errors and retry-after', async () => {
    const client = new CoordinatorClient({
      baseUrl: 'http://localhost:3000',
      credentials: () => ({ workerId: 'worker_abcde', secret: 's' }),
      fetch: respond(
        429,
        { error: { code: 'rate_limited', message: 'slow down' } },
        { 'retry-after': '7' },
      ),
    });
    const error = await client
      .heartbeat({
        worker_id: 'worker_abcde',
        status: 'available',
        providers: [],
        current_tasks: 0,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CoordinatorError);
    expect(error).toMatchObject({ code: 'rate_limited', retryAfterMs: 7000, retryable: true });
  });

  it('refuses oversized responses', async () => {
    const client = new CoordinatorClient({
      baseUrl: 'http://localhost:3000',
      fetch: respond(200, 'x'.repeat(2 * 1024 * 1024)),
    });
    await expect(client.getProject('some-project')).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('refuses to send authenticated requests before registration', async () => {
    const client = new CoordinatorClient({
      baseUrl: 'http://localhost:3000',
      fetch: respond(200, {}),
    });
    await expect(client.workerStats('worker_abcde')).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });
});

describe('scrubSecrets', () => {
  it('masks known secrets and credential-like patterns', () => {
    const text = scrubSecrets(
      'key sk-abcdefghijklmnop; Authorization: Bearer abcdefghijkl; mine=hunter22',
      ['hunter22'],
    );
    expect(text).not.toMatch(/sk-abcdef|abcdefghijkl|hunter22/);
  });
});
