import type { ProjectDefinition } from '@ai-commons/protocol';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  checkAgainstSchema,
  checkInput,
  checkOutput,
  checkProjectDefinition,
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

describe('checkAgainstSchema / checkInput', () => {
  const inputSchema = {
    type: 'object',
    required: ['abstract'],
    properties: { abstract: { type: 'string' } },
  };

  it('distinguishes size failures from schema failures', () => {
    const tooBig = checkAgainstSchema(inputSchema, { abstract: 'x'.repeat(100) }, { maxBytes: 50 });
    expect(tooBig).toMatchObject({ ok: false, reason: 'too_large' });
    const wrong = checkAgainstSchema(inputSchema, { abstract: 1 }, { maxBytes: 50 });
    expect(wrong).toMatchObject({ ok: false, reason: 'schema' });
    if (!wrong.ok) expect(wrong.issues[0]?.path).toBe('/abstract');
  });

  it('caps the number of reported issues', () => {
    const schema = {
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [`f${i}`, { type: 'string' }]),
      ),
    };
    const value = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}`, i]));
    const check = checkAgainstSchema(schema, value, { maxBytes: 10_000, maxIssues: 3 });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.issues).toHaveLength(3);
  });

  it('checkInput allows payloads well above the result limit', () => {
    const payload = { abstract: 'x'.repeat(100_000) };
    expect(checkInput(inputSchema, payload)).toEqual({ ok: true });
    expect(checkOutput(inputSchema, payload)).toMatchObject({ ok: false, reason: 'too_large' });
  });

  it('checkInput rejects payloads over 1 MB', () => {
    const payload = { abstract: 'x'.repeat(1_100_000) };
    expect(checkInput(inputSchema, payload)).toMatchObject({ ok: false, reason: 'too_large' });
  });
});

describe('checkProjectDefinition', () => {
  const def: ProjectDefinition = {
    id: 'demo-project',
    name: 'Demo',
    description: '',
    version: '1.0.0',
    category: 'science',
    input_schema: { type: 'object', properties: { title: { type: 'string' } } },
    output_schema: { type: 'object', properties: { field: { type: 'string' } } },
    prompt: { system: 'Classify.', user: '{{title}}' },
    requirements: {
      capability: 'text_generation',
      minimum_context_window: 8192,
      max_output_tokens: 256,
      local_models_only: false,
    },
    validation: { mode: 'consensus', replication_factor: 2, consensus_fields: ['field'] },
  };
  const messages = (d: ProjectDefinition) => checkProjectDefinition(d).map((i) => i.message);

  it('accepts a consistent definition', () => {
    expect(checkProjectDefinition(def)).toEqual([]);
  });

  it('flags placeholders that are not input properties', () => {
    expect(
      checkProjectDefinition({ ...def, prompt: { system: '{{secret}}', user: '{{title}}' } }),
    ).toEqual([
      {
        path: '/prompt/system',
        message: 'placeholder "{{secret}}" is not an input_schema property',
      },
    ]);
  });

  it('requires input properties', () => {
    expect(messages({ ...def, input_schema: { type: 'object' } })).toContain(
      'input schema must declare properties',
    );
  });

  it('validates consensus settings', () => {
    expect(
      messages({ ...def, validation: { mode: 'consensus', replication_factor: 2 } }),
    ).toContain('consensus mode requires at least one consensus field');
    expect(
      messages({
        ...def,
        validation: { mode: 'consensus', replication_factor: 1, consensus_fields: ['field'] },
      }),
    ).toContain('consensus mode requires replication_factor >= 2');
    expect(
      messages({
        ...def,
        validation: { mode: 'consensus', replication_factor: 2, consensus_fields: ['nope'] },
      }),
    ).toContain('"nope" is not an output_schema property');
  });

  it('prefixes schema issues with the schema location', () => {
    const issues = checkProjectDefinition({
      ...def,
      output_schema: { type: 'object', properties: { field: { $ref: '#/x' } } },
    });
    expect(issues[0]?.path).toBe('/output_schema/properties/field/$ref');
  });
});
