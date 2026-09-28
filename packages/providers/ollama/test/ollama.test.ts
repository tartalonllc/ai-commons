import type { InferenceRequest } from '@ai-commons/provider-core';
import { describe, expect, it } from 'vitest';
import { OllamaProvider, stripThinking } from '../src/index.js';
import { mockFetch, type Reply } from './mock-fetch.js';

const schema = {
  type: 'object',
  required: ['field'],
  properties: { field: { type: 'string' } },
};

const request = (overrides: Partial<InferenceRequest> = {}): InferenceRequest => ({
  model: 'qwen3:8b',
  system: 'Classify.',
  user: 'Abstract text',
  output_schema: schema,
  max_output_tokens: 256,
  timeout_ms: 5_000,
  ...overrides,
});

const chatReply = (content: string, extra: Record<string, unknown> = {}): Reply => ({
  status: 200,
  body: {
    model: 'qwen3:8b',
    message: { role: 'assistant', content },
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 42,
    eval_count: 7,
    ...extra,
  },
});

const provider = (...replies: Reply[]) => {
  const mock = mockFetch(...replies);
  return { ...mock, ollama: new OllamaProvider({ fetch: mock.fetch }) };
};

describe('OllamaProvider.execute', () => {
  it('sends a non-streaming structured chat request and returns parsed output with metrics', async () => {
    const { ollama, calls } = provider(chatReply('{"field":"biology"}'));
    const result = await ollama.execute(request({ temperature: 0 }));

    expect(result).toMatchObject({
      output: { field: 'biology' },
      model: 'qwen3:8b',
      input_tokens: 42,
      output_tokens: 7,
    });
    expect(result.cost_usd).toBeUndefined();
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://localhost:11434/api/chat');
    expect(calls[0]?.body).toEqual({
      model: 'qwen3:8b',
      messages: [
        { role: 'system', content: 'Classify.' },
        { role: 'user', content: 'Abstract text' },
      ],
      stream: false,
      format: schema,
      think: false,
      options: { num_predict: 256, temperature: 0 },
    });
  });

  it('omits an empty system message', async () => {
    const { ollama, calls } = provider(chatReply('{"field":"x"}'));
    await ollama.execute(request({ system: '' }));
    expect((calls[0]?.body as { messages: unknown[] }).messages).toHaveLength(1);
  });

  it('strips <think> blocks and code fences before parsing', async () => {
    const { ollama } = provider(
      chatReply('<think>\nhmm {"field":"wrong"}\n</think>\n```json\n{"field":"physics"}\n```'),
    );
    expect((await ollama.execute(request())).output).toEqual({ field: 'physics' });
  });

  it('retries once without `think` for models that reject it, and remembers', async () => {
    const { ollama, calls } = provider(
      { status: 400, body: { error: '"qwen3:8b" does not support thinking' } },
      chatReply('{"field":"a"}'),
      chatReply('{"field":"b"}'),
    );
    await ollama.execute(request());
    await ollama.execute(request());
    expect(calls.map((c) => 'think' in (c.body as object))).toEqual([true, false, false]);
  });

  it('reports invalid or truncated output as invalid_output', async () => {
    await expect(provider(chatReply('not json')).ollama.execute(request())).rejects.toMatchObject({
      code: 'invalid_output',
    });
    await expect(
      provider(chatReply('{"field":', { done_reason: 'length' })).ollama.execute(request()),
    ).rejects.toMatchObject({
      code: 'invalid_output',
      message: expect.stringContaining('truncated'),
    });
    await expect(
      provider({ status: 200, body: { message: {} } }).ollama.execute(request()),
    ).rejects.toMatchObject({ code: 'invalid_output' });
  });

  it.each([
    [
      { status: 404, body: { error: 'model "x" not found, try pulling it first' } },
      'model_not_found',
      false,
    ],
    [{ status: 401, body: {} }, 'auth', false],
    [{ status: 403, body: {} }, 'auth', false],
    [{ status: 429, body: {}, headers: { 'retry-after': '7' } }, 'rate_limited', true],
    [{ status: 500, body: { error: 'boom' } }, 'unavailable', true],
    [{ status: 503, body: {} }, 'unavailable', true],
    [{ status: 422, body: { error: 'bad schema' } }, 'bad_request', false],
    ['network-error', 'unavailable', true],
  ] as const)('maps %j to %s', async (reply, code, retryable) => {
    const { ollama } = provider(reply as Reply);
    await expect(ollama.execute(request())).rejects.toMatchObject({ code, retryable });
  });

  it('passes Retry-After through as retryAfterMs', async () => {
    const { ollama } = provider({ status: 429, headers: { 'retry-after': '7' } });
    await expect(ollama.execute(request())).rejects.toMatchObject({ retryAfterMs: 7_000 });
  });

  it('surfaces the model-not-found detail from Ollama', async () => {
    const { ollama } = provider({ status: 404, body: { error: 'model "x" not found' } });
    await expect(ollama.execute(request())).rejects.toThrow(/model "x" not found/);
  });

  it('times out after timeout_ms', async () => {
    const { ollama } = provider('hang');
    await expect(ollama.execute(request({ timeout_ms: 20 }))).rejects.toMatchObject({
      code: 'timeout',
    });
  });

  it('reports caller cancellation as cancelled', async () => {
    const { ollama } = provider('hang');
    const controller = new AbortController();
    const pending = ollama.execute(request({ signal: controller.signal }));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled', retryable: false });
  });

  it('does not call the server when already cancelled', async () => {
    const { ollama, calls } = provider();
    await expect(ollama.execute(request({ signal: AbortSignal.abort() }))).rejects.toMatchObject({
      code: 'cancelled',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('OllamaProvider metadata', () => {
  it('lists models with context windows from /api/show, tolerating failures', async () => {
    const { ollama, calls } = provider(
      {
        status: 200,
        body: { models: [{ name: 'qwen3:8b' }, { name: 'llama3.2:3b' }, { bogus: 1 }] },
      },
      {
        status: 200,
        body: { model_info: { 'qwen3.context_length': 40960, 'qwen3.block_count': 36 } },
      },
      { status: 500, body: {} },
    );
    expect(await ollama.getModels()).toEqual([
      { name: 'qwen3:8b', context_window: 40960 },
      { name: 'llama3.2:3b' },
    ]);
    expect(calls.map((c) => c.url.replace('http://localhost:11434', ''))).toEqual([
      '/api/tags',
      '/api/show',
      '/api/show',
    ]);
  });

  it('can skip context window resolution', async () => {
    const mock = mockFetch({ status: 200, body: { models: [{ name: 'a' }] } });
    const ollama = new OllamaProvider({ fetch: mock.fetch, resolveContextWindows: false });
    expect(await ollama.getModels()).toEqual([{ name: 'a' }]);
    expect(mock.calls).toHaveLength(1);
  });

  it('estimates zero cost', async () => {
    const estimate = await provider().ollama.estimateCost(request());
    expect(estimate).toEqual({ max_usd: 0, estimated_input_tokens: 6, max_output_tokens: 256 });
  });

  it('reports health from /api/version', async () => {
    expect(
      await provider({ status: 200, body: { version: '0.12.0' } }).ollama.healthCheck(),
    ).toEqual({
      ok: true,
      message: 'Ollama 0.12.0',
    });
    expect(await provider('network-error').ollama.healthCheck()).toMatchObject({ ok: false });
  });
});

describe('configuration', () => {
  it('normalizes and validates the base URL', async () => {
    const mock = mockFetch({ status: 200, body: { version: '1' } });
    await new OllamaProvider({ baseUrl: 'http://gpu-box:11434/', fetch: mock.fetch }).healthCheck();
    expect(mock.calls[0]?.url).toBe('http://gpu-box:11434/api/version');

    for (const baseUrl of ['ftp://host', 'not a url', 'http://user:pw@host', 'http://h/?x=1']) {
      expect(() => new OllamaProvider({ baseUrl }), baseUrl).toThrow(
        expect.objectContaining({ code: 'bad_request' }),
      );
    }
  });
});

describe('helpers', () => {
  it('stripThinking only removes a leading think block', () => {
    expect(stripThinking('<think>x</think>{"a":1}')).toBe('{"a":1}');
    expect(stripThinking('{"a":"<think>x</think>"}')).toBe('{"a":"<think>x</think>"}');
  });
});
