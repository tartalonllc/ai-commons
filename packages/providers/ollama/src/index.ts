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

export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

export interface OllamaProviderOptions {
  /** Ollama server URL. Defaults to http://localhost:11434. */
  baseUrl?: string;
  /** Timeout for metadata calls (tags, show, version). Inference uses request.timeout_ms. */
  metadataTimeoutMs?: number;
  /** Query /api/show per model to report context windows. Defaults to true. */
  resolveContextWindows?: boolean;
  fetch?: FetchFn;
}

const THINK_BLOCK = /^\s*<think>[\s\S]*?<\/think>\s*/;

export function stripThinking(text: string): string {
  return text.replace(THINK_BLOCK, '');
}

export class OllamaProvider implements AIProvider {
  readonly id = 'ollama';
  readonly kind = 'local' as const;

  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly metadataTimeoutMs: number;
  private readonly resolveContextWindows: boolean;
  /** Models that rejected the `think` field; retried once without it and remembered. */
  private readonly noThinkField = new Set<string>();

  constructor(options: OllamaProviderOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_OLLAMA_URL, 'Ollama');
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.metadataTimeoutMs = options.metadataTimeoutMs ?? 10_000;
    this.resolveContextWindows = options.resolveContextWindows ?? true;
  }

  async getModels(): Promise<ModelInfo[]> {
    const res = await requestJson(
      this.fetchFn,
      `${this.baseUrl}/api/tags`,
      { method: 'GET' },
      { timeoutMs: this.metadataTimeoutMs },
    );
    if (res.status !== 200) throw this.error(res.status, res.headers, res.body);
    if (!isRecord(res.body) || !Array.isArray(res.body.models)) {
      throw new ProviderError('invalid_output', 'Ollama returned an unexpected model list');
    }
    const names = res.body.models
      .map((m) => (isRecord(m) && typeof m.name === 'string' ? m.name : undefined))
      .filter((name): name is string => name !== undefined);

    if (!this.resolveContextWindows) return names.map((name) => ({ name }));
    return Promise.all(
      names.map(async (name) => {
        const contextWindow = await this.contextWindow(name);
        return contextWindow === undefined ? { name } : { name, context_window: contextWindow };
      }),
    );
  }

  async estimateCost(request: InferenceRequest): Promise<CostEstimate> {
    return {
      max_usd: 0,
      estimated_input_tokens: estimateTokens(request.system + request.user),
      max_output_tokens: request.max_output_tokens,
    };
  }

  /** Local inference never costs money, so every failure is reported as unbilled. */
  async execute(request: InferenceRequest): Promise<InferenceResult> {
    try {
      return await this.executeLocal(request);
    } catch (error) {
      throw error instanceof ProviderError ? error.withBilled(false) : error;
    }
  }

  private async executeLocal(request: InferenceRequest): Promise<InferenceResult> {
    const started = performance.now();
    let res = await this.chat(request, !this.noThinkField.has(request.model));
    if (
      res.status === 400 &&
      this.mentionsThinking(res.body) &&
      !this.noThinkField.has(request.model)
    ) {
      this.noThinkField.add(request.model);
      res = await this.chat(request, false);
    }
    if (res.status !== 200) throw this.error(res.status, res.headers, res.body);

    const body = res.body;
    if (!isRecord(body) || !isRecord(body.message) || typeof body.message.content !== 'string') {
      throw new ProviderError('invalid_output', 'Ollama returned an unexpected chat response');
    }
    if (body.done_reason === 'length') {
      throw new ProviderError('invalid_output', 'Model output was truncated at max_output_tokens');
    }
    const output = parseJsonObject(stripThinking(body.message.content));

    const result: InferenceResult = {
      output,
      model: typeof body.model === 'string' ? body.model : request.model,
      duration_ms: Math.round(performance.now() - started),
    };
    const input = optionalCount(body.prompt_eval_count);
    const outputTokens = optionalCount(body.eval_count);
    if (input !== undefined) result.input_tokens = input;
    if (outputTokens !== undefined) result.output_tokens = outputTokens;
    return result;
  }

  async healthCheck(): Promise<ProviderHealth> {
    try {
      const res = await requestJson(
        this.fetchFn,
        `${this.baseUrl}/api/version`,
        { method: 'GET' },
        { timeoutMs: this.metadataTimeoutMs },
      );
      if (res.status !== 200) return { ok: false, message: `Ollama returned HTTP ${res.status}` };
      const version =
        isRecord(res.body) && typeof res.body.version === 'string' ? res.body.version : 'unknown';
      return { ok: true, message: `Ollama ${version}` };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Ollama unreachable' };
    }
  }

  private chat(request: InferenceRequest, includeThink: boolean) {
    const messages = [
      ...(request.system.length > 0 ? [{ role: 'system', content: request.system }] : []),
      { role: 'user', content: request.user },
    ];
    const options: Record<string, number> = { num_predict: request.max_output_tokens };
    if (request.temperature !== undefined) options.temperature = request.temperature;

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      stream: false,
      format: request.output_schema,
      options,
    };
    if (includeThink) body.think = false;

    return requestJson(
      this.fetchFn,
      `${this.baseUrl}/api/chat`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      { timeoutMs: request.timeout_ms, signal: request.signal },
    );
  }

  private async contextWindow(model: string): Promise<number | undefined> {
    try {
      const res = await requestJson(
        this.fetchFn,
        `${this.baseUrl}/api/show`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model }),
        },
        { timeoutMs: this.metadataTimeoutMs },
      );
      if (res.status !== 200 || !isRecord(res.body) || !isRecord(res.body.model_info)) {
        return undefined;
      }
      for (const [key, value] of Object.entries(res.body.model_info)) {
        if (key.endsWith('.context_length')) return optionalCount(value);
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private mentionsThinking(body: unknown): boolean {
    return isRecord(body) && typeof body.error === 'string' && /think/i.test(body.error);
  }

  private error(status: number, headers: Headers, body: unknown): ProviderError {
    const detail = isRecord(body) ? safeDetail(body.error) : undefined;
    return statusError('Ollama', status, headers, detail);
  }
}
