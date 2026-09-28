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
  /**
   * Whether the provider may have charged for the failed call:
   * `false` = definitely not charged, `true` = may have been charged,
   * `undefined` = unknown. Budget accounting treats unknown as charged.
   */
  billed?: boolean | undefined;
  cause?: unknown;
}

/**
 * Adapters throw only ProviderError. Messages must never contain credentials
 * or full request bodies.
 */
export class ProviderError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly billed: boolean | undefined;

  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    options?: ProviderErrorOptions,
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderError';
    this.retryable = RETRYABLE.has(code);
    this.retryAfterMs = options?.retryAfterMs;
    this.billed = options?.billed;
  }

  /** Copy with a different billing verdict; code, message, and retry hint are preserved. */
  withBilled(billed: boolean | undefined): ProviderError {
    return new ProviderError(this.code, this.message, {
      retryAfterMs: this.retryAfterMs,
      billed,
    });
  }
}
