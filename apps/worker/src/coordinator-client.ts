import {
  API_PREFIX,
  ApiError,
  ExtendLeaseResponse,
  HeartbeatResponse,
  LeaseResponse,
  LIMITS,
  parse,
  Project,
  RegisterWorkerResponse,
  ResultSubmissionResponse,
  WorkerStats,
  type ErrorCode,
  type ExtendLeaseRequest,
  type HeartbeatRequest,
  type LeaseRequest,
  type RegisterWorkerRequest,
  type ResultSubmission,
  type TaskFailRequest,
  type UpdateCapabilitiesRequest,
} from '@ai-commons/protocol';
import type { TSchema, Static } from 'typebox';
import { validateCoordinatorUrl } from './config.js';

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

export class CoordinatorError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'network' | 'invalid_response',
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'CoordinatorError';
  }

  get retryable(): boolean {
    return this.code === 'network' || this.status === 429 || this.status >= 500;
  }
}

/** Response bodies larger than a maximal task payload plus envelope are refused. */
const MAX_RESPONSE_BYTES = LIMITS.maxPayloadBytes + 256 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

async function readLimited(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_RESPONSE_BYTES) {
    throw new CoordinatorError(response.status, 'invalid_response', 'response too large');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new CoordinatorError(response.status, 'invalid_response', 'response too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

export interface CoordinatorClientOptions {
  baseUrl: string;
  fetch?: FetchFn;
  /** Returns the bearer credential; never logged. */
  credentials?: () => { workerId: string; secret: string } | undefined;
}

export class CoordinatorClient {
  readonly origin: string;
  private readonly base: string;
  private readonly fetchFn: FetchFn;
  private credentials: CoordinatorClientOptions['credentials'];

  constructor(options: CoordinatorClientOptions) {
    const url = validateCoordinatorUrl(options.baseUrl);
    this.origin = url.origin;
    this.base = `${url.origin}${url.pathname.replace(/\/+$/, '')}${API_PREFIX}`;
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.credentials = options.credentials;
  }

  setCredentials(credentials: CoordinatorClientOptions['credentials']): void {
    this.credentials = credentials;
  }

  private async request<S extends TSchema | undefined>(
    method: 'GET' | 'POST',
    path: string,
    schema: S,
    body?: unknown,
    auth = true,
  ): Promise<S extends TSchema ? Static<S> : undefined> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth) {
      const creds = this.credentials?.();
      if (!creds) throw new CoordinatorError(0, 'unauthorized', 'worker is not registered');
      headers.authorization = `Bearer ${creds.secret}`;
    }

    let response: Response;
    try {
      response = await this.fetchFn(`${this.base}${path}`, {
        method,
        headers,
        body: body === undefined ? null : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'unknown';
      throw new CoordinatorError(0, 'network', `coordinator unreachable (${reason})`);
    }

    const text = await readLimited(response);
    let json: unknown = undefined;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        if (response.ok) {
          throw new CoordinatorError(response.status, 'invalid_response', 'response is not JSON');
        }
      }
    }

    if (!response.ok) {
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
      const err = parse(ApiError, json);
      if (err.ok) {
        throw new CoordinatorError(
          response.status,
          err.value.error.code,
          err.value.error.message.slice(0, 300),
          retryAfter,
        );
      }
      const code: ErrorCode =
        response.status === 401
          ? 'unauthorized'
          : response.status === 404
            ? 'not_found'
            : response.status === 429
              ? 'rate_limited'
              : response.status === 409
                ? 'conflict'
                : response.status >= 500
                  ? 'internal_error'
                  : 'bad_request';
      throw new CoordinatorError(response.status, code, `HTTP ${response.status}`, retryAfter);
    }

    if (schema === undefined) return undefined as S extends TSchema ? Static<S> : undefined;
    const parsed = parse(schema, json);
    if (!parsed.ok) {
      const first = parsed.issues[0];
      throw new CoordinatorError(
        response.status,
        'invalid_response',
        `response failed validation at ${first?.path ?? '/'}: ${first?.message ?? ''}`,
      );
    }
    return parsed.value as S extends TSchema ? Static<S> : undefined;
  }

  register(body: RegisterWorkerRequest) {
    return this.request('POST', '/workers/register', RegisterWorkerResponse, body, false);
  }

  updateCapabilities(body: UpdateCapabilitiesRequest) {
    return this.request('POST', '/workers/capabilities', undefined, body);
  }

  heartbeat(body: HeartbeatRequest) {
    return this.request('POST', '/workers/heartbeat', HeartbeatResponse, body);
  }

  lease(body: LeaseRequest) {
    return this.request('POST', '/tasks/lease', LeaseResponse, body);
  }

  extend(taskId: string, body: ExtendLeaseRequest) {
    return this.request(
      'POST',
      `/tasks/${encodeURIComponent(taskId)}/extend`,
      ExtendLeaseResponse,
      body,
    );
  }

  submitResult(taskId: string, body: ResultSubmission) {
    return this.request(
      'POST',
      `/tasks/${encodeURIComponent(taskId)}/result`,
      ResultSubmissionResponse,
      body,
    );
  }

  fail(taskId: string, body: TaskFailRequest) {
    return this.request('POST', `/tasks/${encodeURIComponent(taskId)}/fail`, undefined, body);
  }

  getProject(projectId: string) {
    return this.request(
      'GET',
      `/projects/${encodeURIComponent(projectId)}`,
      Project,
      undefined,
      false,
    );
  }

  workerStats(workerId: string) {
    return this.request('GET', `/workers/${encodeURIComponent(workerId)}/stats`, WorkerStats);
  }
}
