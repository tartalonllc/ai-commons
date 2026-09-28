import { ProviderError } from './errors.js';

export type FetchFn = typeof globalThis.fetch;

export interface CallOptions {
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

export interface JsonResponse {
  status: number;
  headers: Headers;
  body: unknown;
}

/**
 * Performs a request and reads a JSON body under one combined deadline.
 * Network/abort failures become ProviderError; HTTP status is returned to the caller.
 * No cause is attached, so request details can never leak through error chains.
 */
export async function requestJson(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit,
  options: CallOptions,
): Promise<JsonResponse> {
  if (options.signal?.aborted) throw new ProviderError('cancelled', 'Request cancelled');
  const deadline = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;

  try {
    const response = await fetchFn(url, { ...init, signal });
    const text = await response.text();
    let body: unknown = undefined;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
    }
    return { status: response.status, headers: response.headers, body };
  } catch {
    if (options.signal?.aborted) throw new ProviderError('cancelled', 'Request cancelled');
    if (deadline.aborted) {
      throw new ProviderError('timeout', `Request timed out after ${options.timeoutMs} ms`);
    }
    throw new ProviderError('unavailable', 'Could not connect to provider');
  }
}

/** Parses Retry-After as delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

/**
 * Maps a non-2xx HTTP status to a ProviderError. `detail` must be safe to surface.
 */
export function statusError(
  providerName: string,
  status: number,
  headers: Headers,
  detail?: string,
): ProviderError {
  const suffix = detail ? `: ${detail}` : '';
  if (status === 401 || status === 403) {
    return new ProviderError('auth', `${providerName} rejected credentials (HTTP ${status})`);
  }
  if (status === 404) {
    return new ProviderError('model_not_found', `${providerName} model not found${suffix}`);
  }
  if (status === 429) {
    return new ProviderError('rate_limited', `${providerName} rate limit reached${suffix}`, {
      retryAfterMs: parseRetryAfter(headers.get('retry-after')),
    });
  }
  if (status >= 500) {
    return new ProviderError('unavailable', `${providerName} server error (HTTP ${status})`);
  }
  return new ProviderError(
    'bad_request',
    `${providerName} rejected request (HTTP ${status})${suffix}`,
  );
}

export function normalizeBaseUrl(raw: string, providerName: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderError('bad_request', `Invalid ${providerName} base URL`);
  }
  const reject = (message: string) => new ProviderError('bad_request', message);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw reject(`${providerName} base URL must use http or https`);
  }
  if (url.username !== '' || url.password !== '') {
    throw reject(`${providerName} base URL must not embed credentials`);
  }
  if (url.search !== '' || url.hash !== '') {
    throw reject(`${providerName} base URL must not have a query or hash`);
  }
  return url.href.replace(/\/+$/, '');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function optionalCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** Truncates and strips control characters from server-supplied text before surfacing it. */
export function safeDetail(value: unknown, max = 200): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const cleaned = Array.from(value, (ch) => {
    const code = ch.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? ' ' : ch;
  })
    .join('')
    .trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}
