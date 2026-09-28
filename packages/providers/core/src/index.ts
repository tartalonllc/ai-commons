import type { JsonObject, JsonSchemaDocument, ProviderKind } from '@ai-commons/protocol';

export interface ModelInfo {
  name: string;
  context_window?: number;
}

export interface InferenceRequest {
  model: string;
  system: string;
  user: string;
  /** Project output schema; adapters should use the provider's structured-output mode when available. */
  output_schema: JsonSchemaDocument;
  max_output_tokens: number;
  timeout_ms: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface InferenceResult {
  /** Parsed JSON object returned by the model. Schema validation happens outside the adapter. */
  output: JsonObject;
  model: string;
  duration_ms: number;
  input_tokens?: number;
  output_tokens?: number;
  /** Actual cost computed from reported token usage; omitted for local providers. */
  cost_usd?: number;
}

export interface CostEstimate {
  /** Upper bound in USD assuming `max_output_tokens` are generated. 0 for local providers. */
  max_usd: number;
  estimated_input_tokens: number;
  max_output_tokens: number;
}

export interface ProviderHealth {
  ok: boolean;
  message?: string;
}

export interface AIProvider {
  readonly id: string;
  readonly kind: ProviderKind;
  getModels(): Promise<ModelInfo[]>;
  estimateCost(request: InferenceRequest): Promise<CostEstimate>;
  execute(request: InferenceRequest): Promise<InferenceResult>;
  healthCheck(): Promise<ProviderHealth>;
}

export type ProviderErrorCode =
  | 'unavailable'
  | 'timeout'
  | 'cancelled'
  | 'rate_limited'
  | 'auth'
  | 'bad_request'
  | 'invalid_output'
  | 'model_not_found'
  | 'unknown';

const RETRYABLE: ReadonlySet<ProviderErrorCode> = new Set([
  'unavailable',
  'timeout',
  'rate_limited',
  'invalid_output',
  'unknown',
]);

/**
 * Adapters throw only ProviderError. Messages must never contain credentials
 * or full request bodies.
 */
export class ProviderError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    options?: { retryAfterMs?: number; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderError';
    this.retryable = RETRYABLE.has(code);
    this.retryAfterMs = options?.retryAfterMs;
  }

  readonly retryAfterMs: number | undefined;
}

/** Rough token estimate (≈4 chars/token) for budgeting before a request is sent. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Extracts a JSON object from model text, tolerating ```json fences. */
export function parseJsonObject(text: string): JsonObject {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(text);
  const body = fenced?.[1] ?? text;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (cause) {
    throw new ProviderError('invalid_output', 'Model output is not valid JSON', { cause });
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProviderError('invalid_output', 'Model output is not a JSON object');
  }
  return value as JsonObject;
}
