import type { Static, TSchema } from 'typebox';
import Value from 'typebox/value';

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] };

/** Validates untrusted input against a protocol schema without mutating it. */
export function parse<S extends TSchema>(schema: S, input: unknown): ParseResult<Static<S>> {
  if (Value.Check(schema, input)) return { ok: true, value: input as Static<S> };
  const issues = Value.Errors(schema, input).map((error) => ({
    path: error.instancePath || '/',
    message: error.message,
  }));
  return { ok: false, issues };
}

export function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}
