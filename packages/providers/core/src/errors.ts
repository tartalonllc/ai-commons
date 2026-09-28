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

export interface ProviderErrorOptions {
  retryAfterMs?: number | undefined;
  cause?: unknown;
}

/**
 * Adapters throw only ProviderError. Messages must never contain credentials
 * or full request bodies.
 */
export class ProviderError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    options?: ProviderErrorOptions,
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderError';
    this.retryable = RETRYABLE.has(code);
    this.retryAfterMs = options?.retryAfterMs;
  }
}
