import Type, { type Static } from 'typebox';

export const ErrorCode = Type.Union([
  Type.Literal('bad_request'),
  Type.Literal('unauthorized'),
  Type.Literal('forbidden'),
  Type.Literal('not_found'),
  Type.Literal('conflict'),
  Type.Literal('payload_too_large'),
  Type.Literal('rate_limited'),
  Type.Literal('lease_expired'),
  Type.Literal('unsupported_protocol_version'),
  Type.Literal('internal_error'),
]);
export type ErrorCode = Static<typeof ErrorCode>;

export const ApiError = Type.Object(
  {
    error: Type.Object(
      {
        code: ErrorCode,
        message: Type.String({ maxLength: 1_000 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type ApiError = Static<typeof ApiError>;
