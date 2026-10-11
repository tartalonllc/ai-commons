import type { InferenceRequest } from '@ai-commons/provider-core';
import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_VERSION,
  AnthropicProvider,
  type AnthropicProviderOptions,
} from '../src/index.js';
import { mockFetch, type FetchReply, type Reply } from './mock-fetch.js';

const API_KEY = 'sk-ant-test-SUPERSECRET-0123456789';
const pricing = { 'claude-haiku-test': { input_per_mtok: 1, output_per_mtok: 5 } };
const schema = {
  type: 'object',
  required: ['field', 'confidence'],
  properties: {
    field: { type: 'string', minLength: 1, maxLength: 80 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
};

const request = (overrides: Partial<InferenceRequest> = {}): InferenceRequest => ({
  model: 'claude-haiku-test',
  system: 'Classify.',
  user: 'Abstract text',
  output_schema: schema,
  max_output_tokens: 500,
  timeout_ms: 5_000,
  ...overrides,
});

const message = (text: string, extra: Record<string, unknown> = {}): Reply => ({
  status: 200,
  body: {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-test-20261001',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1_000, output_tokens: 500 },
    ...extra,
  },
});

const provider = (replies: FetchReply[] = [], options: Partial<AnthropicProviderOptions> = {}) => {
  const mock = mockFetch(...replies);
  return {
    ...mock,
    anthropic: new AnthropicProvider({ apiKey: API_KEY, pricing, fetch: mock.fetch, ...options }),
  };
};

describe('AnthropicProvider', () => {
  it('uses Messages API structured output and records reported cost', async () => {
    const { anthropic, calls } = provider([message('{"field":"biology","confidence":0.9}')]);
    const result = await anthropic.execute(request());

    expect(result).toMatchObject({
      output: { field: 'biology', confidence: 0.9 },
      model: 'claude-haiku-test-20261001',
      input_tokens: 1_000,
      output_tokens: 500,
    });
    expect(result.cost_usd).toBeCloseTo(0.0035, 10);
    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0]?.headers['x-api-key']).toBe(API_KEY);
    expect(calls[0]?.headers['anthropic-version']).toBe(ANTHROPIC_VERSION);
    expect(calls[0]?.body).toEqual({
      model: 'claude-haiku-test',
      max_tokens: 500,
      system: 'Classify.',
      messages: [{ role: 'user', content: 'Abstract text' }],
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            required: ['field', 'confidence'],
            properties: {
              field: { type: 'string' },
              confidence: { type: 'number' },
            },
            additionalProperties: false,
          },
        },
      },
    });
  });

  it('lists priced active models and calculates a conservative estimate', async () => {
    const { anthropic, calls } = provider([
      {
        status: 200,
        body: {
          data: [{ id: 'claude-haiku-test' }, { id: 'unpriced-model' }, { id: 123 }],
        },
      },
    ]);
    expect(await anthropic.getModels()).toEqual([{ name: 'claude-haiku-test' }]);
    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/models?limit=1000&lifecycle=active');
    expect((await anthropic.estimateCost(request())).max_usd).toBeGreaterThan(0.0025);
  });

  it('charges the upper bound when usage is missing', async () => {
    const { anthropic } = provider([message('{"field":"x"}', { usage: undefined })]);
    const actual = await anthropic.execute(request());
    expect(actual.cost_usd).toBe((await anthropic.estimateCost(request())).max_usd);
    expect(actual.input_tokens).toBeUndefined();
  });

  it.each([
    ['refusal', message('I cannot help with that', { stop_reason: 'refusal' })],
    ['truncation', message('{"field":', { stop_reason: 'max_tokens' })],
    ['invalid JSON', message('Here is the result')],
    ['missing content', { status: 200, body: { content: [], usage: {} } }],
  ] as [string, Reply][])('treats %s as invalid output and billed', async (_name, reply) => {
    await expect(provider([reply]).anthropic.execute(request())).rejects.toMatchObject({
      code: 'invalid_output',
      billed: true,
    });
  });

  it.each([
    [401, 'auth', false],
    [403, 'auth', false],
    [404, 'model_not_found', false],
    [429, 'rate_limited', true],
    [500, 'unavailable', true],
    [529, 'unavailable', true],
    [400, 'bad_request', false],
  ] as const)('maps HTTP %i to %s', async (status, code, retryable) => {
    const { anthropic } = provider([
      { status, body: { error: { type: 'invalid_request_error', message: API_KEY } } },
    ]);
    const failure: unknown = await anthropic.execute(request()).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code, retryable });
    expect(failure).not.toHaveProperty('message', expect.stringContaining(API_KEY));
  });

  it('reads Retry-After and handles connection failure, timeout, and cancellation', async () => {
    await expect(
      provider([{ status: 429, headers: { 'retry-after': '3' } }]).anthropic.execute(request()),
    ).rejects.toMatchObject({ retryAfterMs: 3_000 });
    await expect(
      provider(['connection-refused']).anthropic.execute(request()),
    ).rejects.toMatchObject({
      code: 'unavailable',
      billed: false,
    });
    await expect(
      provider(['hang']).anthropic.execute(request({ timeout_ms: 20 })),
    ).rejects.toMatchObject({ code: 'timeout' });
    const controller = new AbortController();
    const pending = provider(['hang']).anthropic.execute(request({ signal: controller.signal }));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('refuses unpriced models before sending and does not leak secrets in errors', async () => {
    const { anthropic, calls } = provider([
      { status: 401, body: { error: { type: 'authentication_error', message: API_KEY } } },
    ]);
    await expect(anthropic.execute(request({ model: 'unpriced-model' }))).rejects.toMatchObject({
      code: 'bad_request',
      billed: false,
    });
    expect(calls).toHaveLength(0);
    const error: unknown = await anthropic.getModels().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(API_KEY);
  });

  it('refuses an explicit temperature without sending a request', async () => {
    const { anthropic, calls } = provider();
    await expect(anthropic.execute(request({ temperature: 0.2 }))).rejects.toMatchObject({
      code: 'bad_request',
      billed: false,
    });
    expect(calls).toHaveLength(0);
  });
});
