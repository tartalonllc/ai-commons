import { describe, expect, it } from 'vitest';
import { estimateTokens, parseJsonObject, ProviderError } from '../src/index.js';

describe('parseJsonObject', () => {
  it('parses plain and fenced JSON objects', () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('rejects non-objects and invalid JSON as invalid_output', () => {
    for (const text of ['[1]', 'null', '42', 'not json']) {
      expect(() => parseJsonObject(text)).toThrow(
        expect.objectContaining({ code: 'invalid_output' }),
      );
    }
  });
});

describe('ProviderError', () => {
  it('marks transient failures retryable and auth failures not', () => {
    expect(new ProviderError('rate_limited', 'x', { retryAfterMs: 5 }).retryable).toBe(true);
    expect(new ProviderError('auth', 'x').retryable).toBe(false);
  });
});

it('estimates tokens conservatively', () => {
  expect(estimateTokens('abcdefgh')).toBe(2);
});
