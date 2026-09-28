import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ConfigError } from '../src/config.js';
import { createHarness, type Harness } from './harness.js';

describe('dashboard static hosting', () => {
  let dir: string;
  let h: Harness;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aicommons-dashboard-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>AI Commons</title>');
    writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
    writeFileSync(join(dir, '.env'), 'SECRET=1');
    h = await createHarness({ dashboardDir: dir });
  });

  afterAll(async () => {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves index.html at / with no-cache and a strict CSP', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('caches hashed assets immutably', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/assets/index-abc123.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('leaves API routes untouched', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/network' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('network');
    const missing = await h.app.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('does not list directories, serve dotfiles, or escape the root', async () => {
    for (const url of ['/assets/', '/.env', '/../package.json', '/%2e%2e/package.json']) {
      const res = await h.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBeGreaterThanOrEqual(400);
      expect(res.body, url).not.toContain('SECRET');
      expect(res.body, url).not.toContain('index-abc123.js');
    }
  });

  it('refuses a directory without index.html', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'aicommons-empty-'));
    try {
      await expect(
        buildApp({ config: { ...h.config, dashboardDir: empty }, db: h.handle.db, logger: false }),
      ).rejects.toBeInstanceOf(ConfigError);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
