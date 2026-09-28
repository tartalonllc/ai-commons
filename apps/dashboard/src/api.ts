import { ApiError, NetworkSummary, parse, Project, type ParseResult } from '@ai-commons/protocol';

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export type RequestErrorKind = 'offline' | 'timeout' | 'http' | 'invalid';

export class CoordinatorRequestError extends Error {
  constructor(
    readonly kind: RequestErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'CoordinatorRequestError';
  }
}

const MAX_SERVER_MESSAGE = 200;

/** Read-only client for the coordinator's public endpoints. Every response is schema-checked. */
export class CoordinatorClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly fetchFn: FetchFn = (url, init) => fetch(url, init),
    private readonly timeoutMs = 10_000,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  network(): Promise<NetworkSummary> {
    return this.get('/api/v1/network', (body) => parse(NetworkSummary, body));
  }

  project(id: string): Promise<Project> {
    return this.get(`/api/v1/projects/${encodeURIComponent(id)}`, (body) => parse(Project, body));
  }

  private async get<T>(path: string, check: (body: unknown) => ParseResult<T>): Promise<T> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${path}`, {
        headers: { accept: 'application/json' },
        credentials: 'omit',
        signal,
      });
    } catch {
      if (signal.aborted) throw new CoordinatorRequestError('timeout', 'The coordinator timed out');
      throw new CoordinatorRequestError('offline', 'Cannot reach the coordinator');
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }

    if (!response.ok) {
      const error = parse(ApiError, body);
      const message = error.ok
        ? error.value.error.message.slice(0, MAX_SERVER_MESSAGE)
        : `HTTP ${response.status}`;
      throw new CoordinatorRequestError('http', message, response.status);
    }

    const parsed = check(body);
    if (!parsed.ok) {
      const at = parsed.issues[0]?.path ?? '/';
      throw new CoordinatorRequestError('invalid', `Unexpected response from coordinator (${at})`);
    }
    return parsed.value;
  }
}
