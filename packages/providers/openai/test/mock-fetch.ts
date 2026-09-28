export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export type Reply =
  { status: number; body?: unknown; headers?: Record<string, string> } | 'network-error' | 'hang';

/** Scripted fetch: returns replies in order and records each request. */
export function mockFetch(...replies: Reply[]) {
  const calls: RecordedCall[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const reply = replies.shift();
    if (reply === undefined) throw new Error('unexpected fetch call');
    if (reply === 'network-error') throw new TypeError('fetch failed');
    if (reply === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {});
    return new Response(text, { status: reply.status, headers: reply.headers ?? {} });
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}
