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
  statusError,
  type FetchFn,
} from '@ai-commons/provider-core';

export const DEFAULT_ANTHROPIC_URL = 'https://api.anthropic.com/v1';
export const ANTHROPIC_VERSION = '2023-06-01';

export interface ModelPricing {
  /** USD per million input tokens. */
  input_per_mtok: number;
  /** USD per million output tokens. */
  output_per_mtok: number;
}

export interface AnthropicProviderOptions {
  /** Supplied by the worker from the OS credential store. Never read from env or files here. */
  apiKey: string;
  /** API root including the version segment, e.g. https://api.anthropic.com/v1. */
  baseUrl?: string;
  /** Only models listed here can be estimated and executed. */
  pricing: Readonly<Record<string, ModelPricing>>;
  inputSafetyFactor?: number;
  metadataTimeoutMs?: number;
  fetch?: FetchFn;
}

const UNBILLED = { billed: false } as const;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const SAFE_ERROR_TYPES = new Set([
  'invalid_request_error',
  'authentication_error',
  'permission_error',
  'not_found_error',
  'request_too_large',
  'rate_limit_error',
  'api_error',
  'overloaded_error',
  'timeout_error',
]);

function tokensCost(inputTokens: number, outputTokens: number, price: ModelPricing): number {
  return (inputTokens * price.input_per_mtok + outputTokens * price.output_per_mtok) / 1_000_000;
}

/**
 * Anthropic structured outputs do not support all JSON Schema constraints.
 * Remove unsupported validation keywords for generation; the worker still
 * validates the returned value against the original project schema.
 */
function compatibleSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compatibleSchema);
  if (!isRecord(value)) return value;

  const unsupported = new Set([
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
    'minLength',
    'maxLength',
    'maxItems',
  ]);
  const normalized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (unsupported.has(key)) continue;
    if (key === 'minItems' && typeof child === 'number' && child > 1) continue;
    normalized[key] = compatibleSchema(child);
  }
  if (normalized['type'] === 'object' && isRecord(normalized['properties'])) {
    normalized['additionalProperties'] = false;
  }
  return normalized;
}

export class AnthropicProvider implements AIProvider {
  readonly id = 'anthropic';
  readonly kind = 'remote' as const;

  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #pricing: ReadonlyMap<string, ModelPricing>;
  readonly #fetch: FetchFn;
  readonly #inputSafetyFactor: number;
  readonly #metadataTimeoutMs: number;

  constructor(options: AnthropicProviderOptions) {
    if (typeof options.apiKey !== 'string' || options.apiKey.trim() === '') {
      throw new ProviderError('auth', 'Anthropic API key is not configured', UNBILLED);
    }
    const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_ANTHROPIC_URL, 'Anthropic');
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'https:' && !LOOPBACK.has(parsed.hostname)) {
      throw new ProviderError(
        'bad_request',
        'Anthropic base URL must use https for non-local hosts',
        UNBILLED,
      );
    }

    const pricing = new Map<string, ModelPricing>();
    for (const [model, price] of Object.entries(options.pricing)) {
      const valid = [price.input_per_mtok, price.output_per_mtok].every(
        (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0,
      );
      if (!valid) {
        throw new ProviderError('bad_request', `Invalid pricing for model "${model}"`, UNBILLED);
      }
      pricing.set(model, price);
    }

    const factor = options.inputSafetyFactor ?? 1.5;
    if (!Number.isFinite(factor) || factor < 1) {
      throw new ProviderError('bad_request', 'inputSafetyFactor must be >= 1', UNBILLED);
    }

    this.#apiKey = options.apiKey;
    this.#baseUrl = baseUrl;
    this.#pricing = pricing;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#inputSafetyFactor = factor;
    this.#metadataTimeoutMs = options.metadataTimeoutMs ?? 15_000;
  }

  async getModels(): Promise<ModelInfo[]> {
    const res = await this.get('/models?limit=1000&lifecycle=active');
    if (res.status !== 200) throw this.error(res.status, res.headers, res.body);
    if (!isRecord(res.body) || !Array.isArray(res.body.data)) {
      throw new ProviderError('invalid_output', 'Anthropic returned an unexpected model list');
    }
    const available = new Set(
      res.body.data
        .map((model) => (isRecord(model) && typeof model.id === 'string' ? model.id : undefined))
        .filter((id): id is string => id !== undefined),
    );
    return [...this.#pricing.keys()]
      .filter((name) => available.has(name))
      .map((name) => ({ name }));
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
    if (request.temperature !== undefined) {
      throw new ProviderError(
        'bad_request',
        'Anthropic models do not accept the temperature setting; omit it from the project request',
        UNBILLED,
      );
    }
    const price = this.priceFor(request.model);
    const started = performance.now();
    const payload: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.max_output_tokens,
      messages: [{ role: 'user', content: request.user }],
      output_config: {
        format: {
          type: 'json_schema',
          schema: compatibleSchema(request.output_schema),
        },
      },
    };
    if (request.system.length > 0) payload['system'] = request.system;
    const res = await requestJson(
      this.#fetch,
      `${this.#baseUrl}/messages`,
      { method: 'POST', headers: this.headers(true), body: JSON.stringify(payload) },
      { timeoutMs: request.timeout_ms, signal: request.signal },
    );
    if (res.status !== 200) throw this.error(res.status, res.headers, res.body);

    try {
      return await this.messageResult(request, price, res.body, started);
    } catch (error) {
      // A 200 means generation occurred and was billed, even if output is unusable.
      throw error instanceof ProviderError ? error.withBilled(true) : error;
    }
  }

  private async messageResult(
    request: InferenceRequest,
    price: ModelPricing,
    body: unknown,
    started: number,
  ): Promise<InferenceResult> {
    if (!isRecord(body) || !Array.isArray(body.content)) {
      throw new ProviderError('invalid_output', 'Anthropic returned an unexpected message');
    }
    if (body.stop_reason === 'max_tokens' || body.stop_reason === 'refusal') {
      throw new ProviderError(
        'invalid_output',
        body.stop_reason === 'refusal'
          ? 'Model refused the request'
          : 'Model output was truncated at max_output_tokens',
      );
    }
    const text = body.content
      .filter((block) => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
      .map((block) => (isRecord(block) ? block.text : ''))
      .join('');
    if (text.length === 0)
      throw new ProviderError('invalid_output', 'Anthropic message has no text content');
    const output = parseJsonObject(text);

    const usage = isRecord(body.usage) ? body.usage : {};
    const inputTokens = optionalCount(usage.input_tokens);
    const outputTokens = optionalCount(usage.output_tokens);
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
      result.cost_usd = (await this.estimateCost(request)).max_usd;
    }
    return result;
  }

  async healthCheck(): Promise<ProviderHealth> {
    try {
      const res = await this.get('/models?limit=1&lifecycle=active');
      if (res.status === 200) return { ok: true, message: 'Anthropic reachable' };
      return { ok: false, message: this.error(res.status, res.headers, res.body).message };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Anthropic unreachable',
      };
    }
  }

  private priceFor(model: string): ModelPricing {
    const price = this.#pricing.get(model);
    if (!price) {
      throw new ProviderError(
        'bad_request',
        `No pricing configured for model "${model}"`,
        UNBILLED,
      );
    }
    return price;
  }

  private headers(json: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      'x-api-key': this.#apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    };
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

  /** Surface only the structured error type; provider messages could contain secrets. */
  private error(status: number, headers: Headers, body: unknown): ProviderError {
    const err = isRecord(body) && isRecord(body.error) ? body.error : undefined;
    const type = err && typeof err.type === 'string' ? err.type : undefined;
    const detail = type !== undefined && SAFE_ERROR_TYPES.has(type) ? type : undefined;
    return statusError('Anthropic', status, headers, detail);
  }
}
