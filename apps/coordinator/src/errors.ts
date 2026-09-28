import type { ApiError, ErrorCode } from '@ai-commons/protocol';

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  lease_expired: 409,
  payload_too_large: 413,
  unsupported_protocol_version: 400,
  rate_limited: 429,
  internal_error: 500,
};

export class HttpError extends Error {
  readonly statusCode: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = STATUS[code];
  }

  toBody(): ApiError {
    return { error: { code: this.code, message: this.message } };
  }
}

export function apiError(code: ErrorCode, message: string): ApiError {
  return { error: { code, message: message.slice(0, 1_000) } };
}
