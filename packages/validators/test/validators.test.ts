import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  checkOutput,
  checkProjectSchema,
  consensusKey,
  evaluateConsensus,
  resultHash,
} from '../src/index.js';

const outputSchema = {
  type: 'object',
  required: ['field', 'confidence'],
  properties: {
    field: { type: 'string' },
    topics: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  additionalProperties: false,
};

describe('checkOutput', () => {
  it('accepts conforming results and rejects others with paths', () => {
    expect(checkOutput(outputSchema, { field: 'biology', confidence: 0.9 })).toEqual({ ok: true });
    const bad = checkOutput(outputSchema, { field: 'biology', confidence: 3 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues[0]?.path).toBe('/confidence');
  });

  it('rejects oversized results', () => {
    const big = { field: 'x'.repeat(40_000), confidence: 0.5 };
    expect(checkOutput({ type: 'object' }, big).ok).toBe(false);
  });
});

describe('checkProjectSchema', () => {
  it('accepts plain schemas', () => {
    expect(checkProjectSchema(outputSchema)).toEqual([]);
  });

  it('rejects $ref and unknown keywords', () => {
    const issues = checkProjectSchema({
      type: 'object',
      properties: { a: { $ref: 'https://evil.example/schema.json' } },
    });
    expect(issues.map((i) => i.path)).toEqual(['/properties/a/$ref']);
  });

  it('rejects excessive nesting', () => {
    let schema: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < 20; i++) schema = { type: 'array', items: schema };
    expect(checkProjectSchema(schema).some((i) => i.message.includes('deep'))).toBe(true);
  });
});

describe('hashing', () => {
  it('is independent of key order', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    expect(resultHash('t1', { a: 1, b: 2 }, 'worker_abcde')).toBe(
      resultHash('t1', { b: 2, a: 1 }, 'worker_abcde'),
    );
  });

  it('binds task and worker', () => {
    const r = { a: 1 };
    expect(resultHash('t1', r, 'worker_abcde')).not.toBe(resultHash('t2', r, 'worker_abcde'));
    expect(resultHash('t1', r, 'worker_abcde')).not.toBe(resultHash('t1', r, 'worker_fghij'));
  });
});

describe('evaluateConsensus', () => {
  const c = (worker_id: string, field: string, topics: string[] = []) => ({
    worker_id,
    result: { field, topics, confidence: Math.random() },
  });

  it('ignores non-consensus fields, case, and array order', () => {
    expect(consensusKey({ field: ' Biology', topics: ['b', 'a'] }, ['field', 'topics'])).toBe(
      consensusKey({ field: 'biology', topics: ['a', 'b'] }, ['field', 'topics']),
    );
  });

  it('waits until replication factor is met', () => {
    expect(evaluateConsensus([c('w1', 'biology')], ['field'], 2)).toEqual({
      status: 'pending',
      needed_replicas: 2,
    });
  });

  it('accepts when two replicas agree', () => {
    const outcome = evaluateConsensus([c('w1', 'biology'), c('w2', 'biology')], ['field'], 2);
    expect(outcome).toMatchObject({ status: 'accepted', agreeing: ['w1', 'w2'], dissenting: [] });
  });

  it('requests a tie-breaker on disagreement, then accepts the majority', () => {
    const two = [c('w1', 'biology'), c('w2', 'chemistry')];
    expect(evaluateConsensus(two, ['field'], 2)).toEqual({ status: 'pending', needed_replicas: 3 });
    const three = [...two, c('w3', 'biology')];
    expect(evaluateConsensus(three, ['field'], 2)).toMatchObject({
      status: 'accepted',
      agreeing: ['w1', 'w3'],
      dissenting: ['w2'],
    });
  });

  it('gives up at the replica cap', () => {
    const all = ['a', 'b', 'c'].map((f, i) => c(`w${i}`, f));
    expect(evaluateConsensus(all, ['field'], 2, 3)).toEqual({ status: 'unresolved' });
  });

  it('accepts a single result when replication factor is 1', () => {
    expect(evaluateConsensus([c('w1', 'x')], ['field'], 1).status).toBe('accepted');
  });
});
