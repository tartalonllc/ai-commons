import { inspect } from 'node:util';
import type { InferenceRequest } from '@ai-commons/provider-core';
import { describe, expect, it } from 'vitest';
import { OpenAIProvider, type OpenAIProviderOptions } from '../src/index.js';
import { mockFetch, type Reply } from './mock-fetch.js';

const API_KEY = 'sk-test-SUPERSECRET-0123456789';
const pricing = { 'gpt-test': { input_per_mtok: 2, output_per_mtok: 8 } };
const schema = { type: 'object', properties: { field: { type: 'string' } } };

const request = (overrides: Partial<InferenceRequest> = {}): InferenceRequest => ({
  model: 'gpt-test',
  system: 'Classify.',
  user: 'Abstract text',
  output_schema: schema,
  max_output_tokens: 500,
  timeout_ms: 5_000,
  ...overrides,
});

const completion = (
  message: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Reply => ({
  status: 200,
  body: {
    model: 'gpt-test-2026',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', ...message } }],
    usage: { prompt_tokens: 1_000, completion_tokens: 500 },
    ...extra,
  },
});

const provider = (replies: Reply[] = [], options: Partial<OpenAIProviderOptions> = {}) => {
  const mock = mockFetch(...replies);
  return {
    ...mock,
    openai: new OpenAIProvider({ apiKey: API_KEY, pricing, fetch: mock.fetch, ...options }),
  };
};

describe('OpenAIProvider.execute', () => {
  it('requests structured JSON output and computes actual cost from usage', async () => {
    const { openai, calls } = provider([completion({ content: '{"field":"biology"}' })]);
    const result = await openai.execute(request({ temperature: 0.2 }));

    expect(result).toMatchObject({
      output: { field: 'biology' },
      model: 'gpt-test-2026',
      input_tokens: 1_000,
      output_tokens: 500,
    });
    // 1000 * $2/M + 500 * $8/M
    expect(result.cost_usd).toBeCloseTo(0.006, 10);

    expect(calls[0]?.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(calls[0]?.body).toEqual({
      model: 'gpt-test',
      messages: [
        { role: 'system', content: 'Classify.' },
        { role: 'user', content: 'Abstract text' },
      ],
      max_completion_tokens: 500,
      temperature: 0.2,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'result', schema, strict: false },
      },
    });
  });

  it('omits temperature unless set', async () => {
    const { openai, calls } = provider([completion({ content: '{}' })]);
    await openai.execute(request());
    expect(calls[0]?.body).not.toHaveProperty('temperature');
  });

  it('charges the estimated upper bound when usage is missing', async () => {
    const { openai } = provider([completion({ content: '{}' }, { usage: undefined })]);
    const result = await openai.execute(request());
    const estimate = await openai.estimateCost(request());
    expect(result.cost_usd).toBe(estimate.max_usd);
    expect(result.input_tokens).toBeUndefined();
  });

  it('parses fenced JSON', async () => {
    const { openai } = provider([completion({ content: '```json\n{"field":"x"}\n```' })]);
    expect((await openai.execute(request())).output).toEqual({ field: 'x' });
  });

  it.each([
    ['refusal', completion({ content: null, refusal: 'I cannot help with that' })],
    [
      'truncation',
      {
        status: 200,
        body: { choices: [{ finish_reason: 'length', message: { content: '{"a":' } }] },
      },
    ],
    ['invalid JSON', completion({ content: 'sure! here you go' })],
    ['missing choices', { status: 200, body: { choices: [] } }],
    ['null content', completion({ content: null })],
  ] as [string, Reply][])('treats %s as invalid_output', async (_name, reply) => {
    await expect(provider([reply]).openai.execute(request())).rejects.toMatchObject({
      code: 'invalid_output',
    });
  });

  it.each([
    [401, 'auth', false],
    [403, 'auth', false],
    [404, 'model_not_found', false],
    [429, 'rate_limited', true],
    [500, 'unavailable', true],
    [502, 'unavailable', true],
    [400, 'bad_request', false],
  ] as const)('maps HTTP %i to %s', async (status, code, retryable) => {
    const { openai } = provider([{ status, body: { error: { type: 'x', code: 'some_code' } } }]);
    await expect(openai.execute(request())).rejects.toMatchObject({ code, retryable });
  });

  it('parses Retry-After on 429 (seconds and HTTP date)', async () => {
    await expect(
      provider([{ status: 429, headers: { 'retry-after': '3' } }]).openai.execute(request()),
    ).rejects.toMatchObject({ retryAfterMs: 3_000 });

    const future = new Date(Date.now() + 60_000).toUTCString();
    const error: unknown = await provider([{ status: 429, headers: { 'retry-after': future } }])
      .openai.execute(request())
      .catch((e: unknown) => e);
    expect((error as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(50_000);
  });

  it('maps connection failures, timeouts, and caller cancellation', async () => {
    await expect(provider(['network-error']).openai.execute(request())).rejects.toMatchObject({
      code: 'unavailable',
    });
    await expect(
      provider(['hang']).openai.execute(request({ timeout_ms: 20 })),
    ).rejects.toMatchObject({ code: 'timeout' });

    const controller = new AbortController();
    const pending = provider(['hang']).openai.execute(request({ signal: controller.signal }));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('refuses unpriced models without contacting the API', async () => {
    const { openai, calls } = provider();
    await expect(openai.execute(request({ model: 'gpt-unpriced' }))).rejects.toMatchObject({
      code: 'bad_request',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('OpenAIProvider billing verdicts', () => {
  const failure = async (replies: Reply[], req: Partial<InferenceRequest> = {}) =>
    provider(replies)
      .openai.execute(request(req))
      .catch((e: unknown) => e as { code: string; billed: boolean | undefined });

  it('marks refusals that happen before generation as unbilled', async () => {
    expect(await failure([], { model: 'gpt-unpriced' })).toMatchObject({ billed: false });
    expect(await failure([], { signal: AbortSignal.abort() })).toMatchObject({
      code: 'cancelled',
      billed: false,
    });
    expect(await failure(['connection-refused'])).toMatchObject({
      code: 'unavailable',
      billed: false,
    });
    for (const status of [400, 401, 403, 404, 422, 429]) {
      expect(await failure([{ status }]), String(status)).toMatchObject({ billed: false });
    }
  });

  it('marks unusable 200 responses as billed', async () => {
    const replies: Reply[] = [
      completion({ content: 'not json' }),
      completion({ content: '[1,2]' }),
      completion({ content: null, refusal: 'no' }),
      { status: 200, body: { choices: [{ finish_reason: 'length', message: { content: '{' } }] } },
      { status: 200, body: 'garbage' },
    ];
    for (const reply of replies) {
      expect(await failure([reply])).toMatchObject({ code: 'invalid_output', billed: true });
    }
  });

  it('leaves billing unknown when the request may have been processed', async () => {
    expect(await failure([{ status: 500 }])).toMatchObject({ billed: undefined });
    expect(await failure(['network-error'])).toMatchObject({ billed: undefined });
    expect(await failure(['hang'], { timeout_ms: 20 })).toMatchObject({
      code: 'timeout',
      billed: undefined,
    });
  });

  it('marks constructor refusals as unbilled', () => {
    expect(() => new OpenAIProvider({ apiKey: '', pricing })).toThrow(
      expect.objectContaining({ billed: false }),
    );
  });
});

describe('OpenAIProvider.estimateCost', () => {
  it('prices a conservative input bound plus max output tokens', async () => {
    const { openai } = provider([], { inputSafetyFactor: 2 });
    const req = request({ system: 'x'.repeat(400), user: 'y'.repeat(400) });
    const estimate = await openai.estimateCost(req);
    const schemaTokens = Math.ceil(JSON.stringify(schema).length / 4);
    expect(estimate.estimated_input_tokens).toBe(200 + schemaTokens);
    expect(estimate.max_output_tokens).toBe(500);
    const expected = ((200 + schemaTokens) * 2 * 2 + 500 * 8) / 1_000_000;
    expect(estimate.max_usd).toBeCloseTo(expected, 12);
  });

  it('throws bad_request for models missing from the pricing table', async () => {
    await expect(provider().openai.estimateCost(request({ model: 'nope' }))).rejects.toMatchObject({
      code: 'bad_request',
    });
  });
});

describe('credential safety', () => {
  const leakyBody = {
    error: {
      message: `Incorrect API key provided: ${API_KEY}. You can find your API key at ...`,
      type: 'invalid_request_error',
      code: 'invalid_api_key',
    },
  };

  it('never includes the API key in thrown errors', async () => {
    const replies: Reply[] = [
      { status: 401, body: leakyBody },
      { status: 400, body: leakyBody },
      { status: 500, body: leakyBody },
      { status: 429, body: leakyBody },
      completion({ content: `not json ${API_KEY}` }),
      'network-error',
    ];
    for (const reply of replies) {
      const error: unknown = await provider([reply])
        .openai.execute(request())
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      const serialized = [
        JSON.stringify(error),
        JSON.stringify(error, Object.getOwnPropertyNames(error)),
        inspect(error, { depth: 10, showHidden: true }),
        String(error),
      ].join('\n');
      expect(serialized).not.toContain('SUPERSECRET');
    }
  });

  it('surfaces only the structured error code', async () => {
    const { openai } = provider([{ status: 401, body: leakyBody }]);
    await expect(openai.execute(request())).rejects.toThrow(
      'OpenAI rejected credentials (HTTP 401)',
    );
    const { openai: o2 } = provider([{ status: 400, body: leakyBody }]);
    await expect(o2.execute(request())).rejects.toThrow(/invalid_api_key$/);
  });

  it('does not expose the key on the provider object', () => {
    const { openai } = provider();
    expect(JSON.stringify(openai)).not.toContain('SUPERSECRET');
    expect(inspect(openai, { depth: 10, showHidden: true })).not.toContain('SUPERSECRET');
    expect(Object.values(openai).join(' ')).not.toContain('SUPERSECRET');
  });

  it('never reports the key through healthCheck', async () => {
    const health = await provider([{ status: 401, body: leakyBody }]).openai.healthCheck();
    expect(health.ok).toBe(false);
    expect(JSON.stringify(health)).not.toContain('SUPERSECRET');
  });
});

describe('configuration', () => {
  it('rejects an empty key', () => {
    expect(() => new OpenAIProvider({ apiKey: ' ', pricing })).toThrow(
      expect.objectContaining({ code: 'auth' }),
    );
  });

  it('requires https except for loopback OpenAI-compatible servers', async () => {
    expect(
      () => new OpenAIProvider({ apiKey: API_KEY, pricing, baseUrl: 'http://example.com/v1' }),
    ).toThrow(expect.objectContaining({ code: 'bad_request' }));
    const { openai, calls } = provider([completion({ content: '{}' })], {
      baseUrl: 'http://localhost:8080/v1/',
      id: 'local-vllm',
    });
    await openai.execute(request());
    expect(calls[0]?.url).toBe('http://localhost:8080/v1/chat/completions');
    expect(openai.id).toBe('local-vllm');
    expect(openai.kind).toBe('remote');
  });

  it('rejects invalid pricing and safety factors', () => {
    expect(
      () =>
        new OpenAIProvider({
          apiKey: API_KEY,
          pricing: { m: { input_per_mtok: -1, output_per_mtok: 1 } },
        }),
    ).toThrow(expect.objectContaining({ code: 'bad_request' }));
    expect(
      () =>
        new OpenAIProvider({
          apiKey: API_KEY,
          pricing: { m: { input_per_mtok: Number.NaN, output_per_mtok: 1 } },
        }),
    ).toThrow(expect.objectContaining({ code: 'bad_request' }));
    expect(() => new OpenAIProvider({ apiKey: API_KEY, pricing, inputSafetyFactor: 0.5 })).toThrow(
      expect.objectContaining({ code: 'bad_request' }),
    );
  });
});

describe('OpenAIProvider metadata', () => {
  it('lists priced models that the endpoint reports', async () => {
    const { openai, calls } = provider(
      [{ status: 200, body: { data: [{ id: 'gpt-test' }, { id: 'gpt-other' }] } }],
      { pricing: { ...pricing, 'gpt-gone': { input_per_mtok: 1, output_per_mtok: 1 } } },
    );
    expect(await openai.getModels()).toEqual([{ name: 'gpt-test' }]);
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/models');
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${API_KEY}`);
  });

  it('falls back to the pricing table when /models is not implemented', async () => {
    const { openai } = provider([{ status: 404, body: {} }]);
    expect(await openai.getModels()).toEqual([{ name: 'gpt-test' }]);
  });

  it('propagates auth failures from model listing', async () => {
    await expect(provider([{ status: 401 }]).openai.getModels()).rejects.toMatchObject({
      code: 'auth',
    });
  });

  it('reports health', async () => {
    expect((await provider([{ status: 200, body: { data: [] } }]).openai.healthCheck()).ok).toBe(
      true,
    );
    expect((await provider(['network-error']).openai.healthCheck()).ok).toBe(false);
  });
});
