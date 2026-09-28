import { describe, expect, it } from 'vitest';
import {
  normalizeBaseUrl,
  parseRetryAfter,
  requestJson,
  safeDetail,
  statusError,
  type FetchFn,
} from '../src/index.js';

const reply =
  (status: number, text: string, headers: Record<string, string> = {}): FetchFn =>
  async () =>
    new Response(text, { status, headers });

const failing =
  (error: unknown): FetchFn =>
  async () => {
    throw error;
  };

const hanging: FetchFn = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

const refused = () =>
  new TypeError('fetch failed', {
    cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
  });

describe('requestJson', () => {
  it('returns status, headers, and parsed body; tolerates non-JSON bodies', async () => {
    const ok = await requestJson(
      reply(200, '{"a":1}', { 'x-h': 'v' }),
      'http://h',
      {},
      {
        timeoutMs: 1_000,
      },
    );
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ a: 1 });
    expect(ok.headers.get('x-h')).toBe('v');
    expect((await requestJson(reply(500, 'oops'), 'http://h', {}, { timeoutMs: 1_000 })).body).toBe(
      undefined,
    );
    expect((await requestJson(reply(200, ''), 'http://h', {}, { timeoutMs: 1_000 })).body).toBe(
      undefined,
    );
  });

  it('does not call fetch when already cancelled', async () => {
    let called = false;
    const fetchFn: FetchFn = async () => {
      called = true;
      return new Response('{}');
    };
    await expect(
      requestJson(fetchFn, 'http://h', {}, { timeoutMs: 1_000, signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(called).toBe(false);
  });

  it('maps timeouts and mid-flight cancellation', async () => {
    await expect(requestJson(hanging, 'http://h', {}, { timeoutMs: 20 })).rejects.toMatchObject({
      code: 'timeout',
    });
    const controller = new AbortController();
    const pending = requestJson(
      hanging,
      'http://h',
      {},
      {
        timeoutMs: 5_000,
        signal: controller.signal,
      },
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('maps network failures to unavailable', async () => {
    await expect(
      requestJson(failing(refused()), 'http://h', {}, { timeoutMs: 1_000 }),
    ).rejects.toMatchObject({ code: 'unavailable' });
    await expect(
      requestJson(failing(new TypeError('fetch failed')), 'http://h', {}, { timeoutMs: 1_000 }),
    ).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('never attaches the underlying error as a cause', async () => {
    const error = await requestJson(failing(refused()), 'http://h', {}, { timeoutMs: 1_000 }).catch(
      (e: unknown) => e,
    );
    expect((error as Error).cause).toBeUndefined();
  });
});

describe('statusError', () => {
  const h = new Headers({ 'retry-after': '3' });
  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [404, 'model_not_found'],
    [429, 'rate_limited'],
    [400, 'bad_request'],
    [422, 'bad_request'],
    [500, 'unavailable'],
    [503, 'unavailable'],
  ])('HTTP %i → %s', (status, code) => {
    expect(statusError('P', status, h).code).toBe(code);
  });

  it('carries Retry-After on 429 and appends safe detail', () => {
    expect(statusError('P', 429, h, 'slow down')).toMatchObject({
      retryAfterMs: 3_000,
      message: 'P rate limit reached: slow down',
    });
  });
});

describe('parseRetryAfter', () => {
  it('parses seconds and HTTP dates', () => {
    const now = Date.parse('2026-09-28T12:00:00Z');
    expect(parseRetryAfter('2.5', now)).toBe(2_500);
    expect(parseRetryAfter('Mon, 28 Sep 2026 12:00:10 GMT', now)).toBe(10_000);
    expect(parseRetryAfter('garbage', now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });
});

describe('normalizeBaseUrl', () => {
  it('strips trailing slashes and rejects unsafe URLs', () => {
    expect(normalizeBaseUrl('http://host:1/v1/', 'P')).toBe('http://host:1/v1');
    for (const raw of ['ftp://h', 'nope', 'http://u:p@h', 'http://h/?q=1', 'http://h/#x']) {
      expect(() => normalizeBaseUrl(raw, 'P'), raw).toThrow(
        expect.objectContaining({ code: 'bad_request' }),
      );
    }
  });
});

describe('safeDetail', () => {
  it('strips control characters and truncates', () => {
    expect(safeDetail('a\nb\u0007c')).toBe('a b c');
    expect(safeDetail('x'.repeat(10), 4)).toBe('xxxx…');
    expect(safeDetail(42)).toBeUndefined();
  });
});
