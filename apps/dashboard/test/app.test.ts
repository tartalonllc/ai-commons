import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoordinatorClient, type FetchFn } from '../src/api.js';
import { Dashboard, parseRoute } from '../src/app.js';
import { jsonResponse, network, NOW, project } from './fixtures.js';

describe('parseRoute', () => {
  it('maps hashes to views', () => {
    expect(parseRoute('')).toEqual({ name: 'overview' });
    expect(parseRoute('#/')).toEqual({ name: 'overview' });
    expect(parseRoute('#/projects/open-literature-demo')).toEqual({
      name: 'project',
      id: 'open-literature-demo',
    });
  });

  it('rejects malformed or hostile ids', () => {
    for (const hash of [
      '#/projects/..%2F..%2Fworkers',
      '#/projects/%E0%A4%A',
      '#/projects/UPPER',
      '#/projects/a/b',
      '#/nowhere',
    ]) {
      expect(parseRoute(hash), hash).toEqual({ name: 'not_found' });
    }
  });
});

describe('CoordinatorClient', () => {
  it('validates responses against protocol schemas', async () => {
    const ok = new CoordinatorClient('http://c.example/', async (url) => {
      expect(url).toBe('http://c.example/api/v1/network');
      return jsonResponse(network());
    });
    await expect(ok.network()).resolves.toMatchObject({ network: { tasks_completed: 8214 } });

    const bad = new CoordinatorClient('', async () =>
      jsonResponse({ ...network(), workers: [{ worker_id: 'x' }] }),
    );
    await expect(bad.network()).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('classifies failures', async () => {
    const offline = new CoordinatorClient('', async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(offline.network()).rejects.toMatchObject({ kind: 'offline' });

    const notFound = new CoordinatorClient('', async () =>
      jsonResponse({ error: { code: 'not_found', message: 'Project not found' } }, 404),
    );
    await expect(notFound.project('nope-project')).rejects.toMatchObject({
      kind: 'http',
      status: 404,
      message: 'Project not found',
    });

    const html = new CoordinatorClient('', async () => new Response('<html>', { status: 502 }));
    await expect(html.network()).rejects.toMatchObject({ kind: 'http', message: 'HTTP 502' });
  });

  it('encodes project ids in the path', async () => {
    const seen: string[] = [];
    const client = new CoordinatorClient('', async (url) => {
      seen.push(url);
      return jsonResponse(project());
    });
    await client.project('open-literature-demo');
    expect(seen).toEqual(['/api/v1/projects/open-literature-demo']);
  });
});

describe('Dashboard', () => {
  let root: HTMLElement;
  let responses: (() => Response)[];
  let fetchFn: FetchFn;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.replaceChildren(root);
    window.location.hash = '';
    responses = [];
    fetchFn = vi.fn(async (url: string) => {
      if (url.includes('/projects/')) return jsonResponse(project());
      const next = responses.shift();
      if (!next) throw new TypeError('offline');
      return next();
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const make = () =>
    new Dashboard({ root, client: new CoordinatorClient('', fetchFn), now: () => NOW });

  it('renders the overview after a successful refresh', async () => {
    responses.push(() => jsonResponse(network()));
    const d = make();
    await d.refresh();
    expect(root.textContent).toContain('Open Literature Classification');
    expect(root.querySelector('.status')?.textContent).toContain('Live');
    expect(root.querySelector('[role="alert"]')?.textContent).toBe('');
    expect(document.title).toBe('Network · AI Commons');
  });

  it('keeps last data and shows a banner when the coordinator goes away', async () => {
    responses.push(() => jsonResponse(network()));
    const d = make();
    await d.refresh();
    await d.refresh();
    expect(root.textContent).toContain('Open Literature Classification');
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      'Cannot reach the coordinator',
    );
    expect(root.querySelector('.status')?.textContent).toContain('Offline');
  });

  it('backs off exponentially on repeated failures, capped', async () => {
    const d = new Dashboard({
      root,
      client: new CoordinatorClient('', fetchFn),
      now: () => NOW,
      pollMs: 5_000,
      maxBackoffMs: 60_000,
    });
    expect(d.nextDelayMs()).toBe(5_000);
    await d.refresh();
    expect(d.nextDelayMs()).toBe(10_000);
    await d.refresh();
    await d.refresh();
    await d.refresh();
    expect(d.nextDelayMs()).toBe(60_000);
    responses.push(() => jsonResponse(network()));
    await d.refresh();
    expect(d.nextDelayMs()).toBe(5_000);
  });

  it('shows the public project page for #/projects/:id', async () => {
    responses.push(() => jsonResponse(network()));
    const d = make();
    await d.refresh();
    window.location.hash = '#/projects/open-literature-demo';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    d.start();
    await vi.waitFor(() => expect(root.querySelector('h1')?.textContent).toBe(project().name));
    expect(root.textContent).toContain('What volunteers run');
    expect(document.title).toBe('Open Literature Classification · AI Commons');
    d.stop();
  });

  it('shows not-found for unknown projects', async () => {
    const client = new CoordinatorClient('', async () =>
      jsonResponse({ error: { code: 'not_found', message: 'Project not found' } }, 404),
    );
    const d = new Dashboard({ root, client, now: () => NOW });
    window.location.hash = '#/projects/missing-project';
    d.start();
    await vi.waitFor(() => expect(root.querySelector('h1')?.textContent).toBe('Project not found'));
    d.stop();
  });
});
