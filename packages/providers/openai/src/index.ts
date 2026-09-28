import {
  estimateTokens,
  parseJsonObject,
  ProviderError,
  type AIProvider,
  type CostEstimate,
  type InferenceRequest,
  type InferenceResult,
  type ModelInfo,
  type ProviderHealth,
  isRecord,
  normalizeBaseUrl,
  optionalCount,
  requestJson,
  safeDetail,
  statusError,
  type FetchFn,
} from '@ai-commons/provider-core';

export const DEFAULT_OPENAI_URL = 'https://api.openai.com/v1';

export interface ModelPricing {
  /** USD per million input tokens. */
  input_per_mtok: number;
  /** USD per million output tokens. */
  output_per_mtok: number;
}

export interface OpenAIProviderOptions {
  /** Supplied by the worker from the OS credential store. Never read from env or files here. */
  apiKey: string;
  /** API root including the version segment, e.g. https://api.openai.com/v1. */
  baseUrl?: string;
  /** Only models listed here can be estimated and executed. */
  pricing: Readonly<Record<string, ModelPricing>>;
  /** Provider id reported to the coordinator; override for OpenAI-compatible endpoints. */
  id?: string;
  /**
   * Multiplier applied to the heuristic input-token estimate when computing
   * `max_usd`, since ~4 chars/token undercounts some languages. Defaults to 1.5.
   */
  inputSafetyFactor?: number;
  /** Timeout for metadata calls (model listing, health). */
  metadataTimeoutMs?: number;
  fetch?: FetchFn;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

function tokensCost(inputTokens: number, outputTokens: number, price: ModelPricing): number {
  return (inputTokens * price.input_per_mtok + outputTokens * price.output_per_mtok) / 1_000_000;
}

export class OpenAIProvider implements AIProvider {
  readonly id: string;
  readonly kind = 'remote' as const;

  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #pricing: ReadonlyMap<string, ModelPricing>;
  readonly #fetch: FetchFn;
  readonly #inputSafetyFactor: number;
  readonly #metadataTimeoutMs: number;

  constructor(options: OpenAIProviderOptions) {
    if (typeof options.apiKey !== 'string' || options.apiKey.trim() === '') {
      throw new ProviderError('auth', 'OpenAI API key is not configured');
    }
    const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_OPENAI_URL, 'OpenAI');
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'https:' && !LOOPBACK.has(parsed.hostname)) {
      throw new ProviderError('bad_request', 'OpenAI base URL must use https for non-local hosts');
    }

    const pricing = new Map<string, ModelPricing>();
    for (const [model, price] of Object.entries(options.pricing)) {
      const valid = [price.input_per_mtok, price.output_per_mtok].every(
        (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0,
      );
      if (!valid) throw new ProviderError('bad_request', `Invalid pricing for model "${model}"`);
      pricing.set(model, price);
    }

    const factor = options.inputSafetyFactor ?? 1.5;
    if (!Number.isFinite(factor) || factor < 1) {
      throw new ProviderError('bad_request', 'inputSafetyFactor must be >= 1');
    }

    this.id = options.id ?? 'openai';
    this.#apiKey = options.apiKey;
    this.#baseUrl = baseUrl;
    this.#pricing = pricing;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#inputSafetyFactor = factor;
    this.#metadataTimeoutMs = options.metadataTimeoutMs ?? 15_000;
  }

  /** Priced models, intersected with the endpoint's /models listing when it is available. */
  async getModels(): Promise<ModelInfo[]> {
    const priced = [...this.#pricing.keys()];
    const res = await this.get('/models');
    if (res.status === 404) return priced.map((name) => ({ name }));
    if (res.status !== 200) throw this.error(res.status, res.headers, res.body);
    if (!isRecord(res.body) || !Array.isArray(res.body.data)) {
      throw new ProviderError('invalid_output', 'OpenAI returned an unexpected model list');
    }
    const available = new Set(
      res.body.data
        .map((m) => (isRecord(m) && typeof m.id === 'string' ? m.id : undefined))
        .filter((id): id is string => id !== undefined),
    );
    return priced.filter((name) => available.has(name)).map((name) => ({ name }));
  }

  async estimateCost(request: InferenceRequest): Promise<CostEstimate> {
    const price = this.priceFor(request.model);
    const estimatedInput =
      estimateTokens(request.system + request.user) +
      estimateTokens(JSON.stringify(request.output_schema));
    const boundedInput = Math.ceil(estimatedInput * this.#inputSafetyFactor);
    return {
      max_usd: tokensCost(boundedInput, request.max_output_tokens, price),
      estimated_input_tokens: estimatedInput,
      max_output_tokens: request.max_output_tokens,
    };
  }

  async execute(request: InferenceRequest): Promise<InferenceResult> {
    const price = this.priceFor(request.model);
    const started = performance.now();

    const messages = [
      ...(request.system.length > 0 ? [{ role: 'system', content: request.system }] : []),
      { role: 'user', content: request.user },
    ];
    const payload: Record<string, unknown> = {
      model: request.model,
      messages,
      max_completion_tokens: request.max_output_tokens,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'result', schema: request.output_schema, strict: false },
      },
    };
    if (request.temperature !== undefined) payload.temperature = request.temperature;

    const res = await requestJson(
      this.#fetch,
      `${this.#baseUrl}/chat/completions`,
      { method: 'POST', headers: this.headers(true), body: JSON.stringify(payload) },
      { timeoutMs: request.timeout_ms, signal: request.signal },
    );
    if (res.status !== 200) throw this.error(res.status, res.headers, res.body);

    const body = res.body;
    const choice = isRecord(body) && Array.isArray(body.choices) ? body.choices[0] : undefined;
    const message = isRecord(choice) ? choice.message : undefined;
    if (!isRecord(body) || !isRecord(choice) || !isRecord(message)) {
      throw new ProviderError('invalid_output', 'OpenAI returned an unexpected completion');
    }
    if (typeof message.refusal === 'string' && message.refusal.length > 0) {
      throw new ProviderError('invalid_output', 'Model refused the request');
    }
    if (choice.finish_reason === 'length') {
      throw new ProviderError('invalid_output', 'Model output was truncated at max_output_tokens');
    }
    if (typeof message.content !== 'string') {
      throw new ProviderError('invalid_output', 'OpenAI completion has no text content');
    }
    const output = parseJsonObject(message.content);

    const usage = isRecord(body.usage) ? body.usage : {};
    const inputTokens = optionalCount(usage.prompt_tokens);
    const outputTokens = optionalCount(usage.completion_tokens);

    const result: InferenceResult = {
      output,
      model: typeof body.model === 'string' ? body.model : request.model,
      duration_ms: Math.round(performance.now() - started),
    };
    if (inputTokens !== undefined && outputTokens !== undefined) {
      result.input_tokens = inputTokens;
      result.output_tokens = outputTokens;
      result.cost_usd = tokensCost(inputTokens, outputTokens, price);
    } else {
      // Usage missing: record the pre-request upper bound so local budgets never undercount.
      result.cost_usd = (await this.estimateCost(request)).max_usd;
    }
    return result;
  }

  async healthCheck(): Promise<ProviderHealth> {
    try {
      const res = await this.get('/models');
      if (res.status === 200 || res.status === 404)
        return { ok: true, message: 'OpenAI reachable' };
      return { ok: false, message: this.error(res.status, res.headers, res.body).message };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'OpenAI unreachable' };
    }
  }

  private priceFor(model: string): ModelPricing {
    const price = this.#pricing.get(model);
    if (!price) {
      throw new ProviderError('bad_request', `No pricing configured for model "${model}"`);
    }
    return price;
  }

  private headers(json: boolean): Record<string, string> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.#apiKey}` };
    if (json) headers['content-type'] = 'application/json';
    return headers;
  }

  private get(path: string) {
    return requestJson(
      this.#fetch,
      `${this.#baseUrl}${path}`,
      { method: 'GET', headers: this.headers(false) },
      { timeoutMs: this.#metadataTimeoutMs },
    );
  }

  /**
   * Only the structured error `code`/`type` enum is surfaced: OpenAI's free-text
   * messages can echo a masked form of the API key.
   */
  private error(status: number, headers: Headers, body: unknown): ProviderError {
    const err = isRecord(body) && isRecord(body.error) ? body.error : undefined;
    const code = err ? (safeDetail(err.code, 64) ?? safeDetail(err.type, 64)) : undefined;
    const detail = code !== undefined && /^[A-Za-z0-9_.-]+$/.test(code) ? code : undefined;
    return statusError('OpenAI', status, headers, detail);
  }
}
