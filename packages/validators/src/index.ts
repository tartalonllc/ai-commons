import { createHash } from 'node:crypto';
import {
  jsonByteLength,
  LIMITS,
  type JsonObject,
  type JsonSchemaDocument,
  type ValidationIssue,
} from '@ai-commons/protocol';
import Value from 'typebox/value';

export type OutputCheck = { ok: true } | { ok: false; issues: ValidationIssue[] };

/**
 * Validates a model result against a project's output JSON Schema. Schemas are
 * interpreted (never compiled to code), so untrusted project schemas are safe.
 */
export function checkOutput(schema: JsonSchemaDocument, result: unknown): OutputCheck {
  if (jsonByteLength(result) > LIMITS.maxResultBytes) {
    return { ok: false, issues: [{ path: '/', message: 'result exceeds maximum size' }] };
  }
  if (Value.Check(schema, result)) return { ok: true };
  const issues = Value.Errors(schema, result)
    .slice(0, 20)
    .map((e) => ({ path: e.instancePath || '/', message: e.message }));
  return { ok: false, issues };
}

const SUPPORTED_KEYWORDS = new Set([
  '$schema',
  'title',
  'description',
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'uniqueItems',
  'format',
  'anyOf',
  'oneOf',
  'allOf',
  'multipleOf',
  'default',
  'examples',
]);

/**
 * Rejects project schemas that use `$ref`/`$id` (no remote resolution),
 * unknown keywords, or excessive nesting. Run at project creation.
 */
export function checkProjectSchema(schema: JsonSchemaDocument, maxDepth = 12): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const visit = (node: unknown, path: string, depth: number): void => {
    if (depth > maxDepth) {
      issues.push({ path, message: 'schema nesting too deep' });
      return;
    }
    if (typeof node !== 'object' || node === null || Array.isArray(node)) {
      if (typeof node !== 'boolean') issues.push({ path, message: 'schema must be an object' });
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const at = `${path}/${key}`;
      if (!SUPPORTED_KEYWORDS.has(key)) {
        issues.push({ path: at, message: `unsupported keyword "${key}"` });
      } else if (key === 'properties') {
        if (typeof value !== 'object' || value === null) {
          issues.push({ path: at, message: 'properties must be an object' });
        } else {
          for (const [prop, sub] of Object.entries(value)) visit(sub, `${at}/${prop}`, depth + 1);
        }
      } else if (key === 'items' || key === 'additionalProperties') {
        visit(value, at, depth + 1);
      } else if (key === 'anyOf' || key === 'oneOf' || key === 'allOf') {
        if (!Array.isArray(value)) issues.push({ path: at, message: `${key} must be an array` });
        else value.forEach((sub, i) => visit(sub, `${at}/${i}`, depth + 1));
      }
    }
  };
  visit(schema, '', 0);
  return issues;
}

/** Deterministic JSON: object keys sorted recursively. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256(task_id + canonical result JSON + worker_id), hex encoded. */
export function resultHash(taskId: string, result: JsonObject, workerId: string): string {
  return createHash('sha256')
    .update(taskId)
    .update('\n')
    .update(canonicalJson(result))
    .update('\n')
    .update(workerId)
    .digest('hex');
}

export interface ConsensusCandidate {
  worker_id: string;
  result: JsonObject;
}

export type ConsensusOutcome =
  /** A strict majority of `required` replicas agree; `agreeing` holds their worker IDs. */
  | { status: 'accepted'; key: string; agreeing: string[]; dissenting: string[] }
  /** Not enough agreeing results yet; `needed_replicas` is the total now required. */
  | { status: 'pending'; needed_replicas: number }
  /** Hit the replica cap without a majority. */
  | { status: 'unresolved' };

function normalizeForComparison(value: unknown): unknown {
  if (typeof value === 'string') return value.trim().toLowerCase();
  if (Array.isArray(value)) {
    return value.map(normalizeForComparison).map(canonicalJson).sort();
  }
  return value;
}

/** Comparison key built from the consensus fields only (strings case/whitespace-insensitive, arrays order-insensitive). */
export function consensusKey(result: JsonObject, fields: readonly string[]): string {
  const picked: Record<string, unknown> = {};
  for (const field of fields) picked[field] = normalizeForComparison(result[field]);
  return canonicalJson(picked);
}

/**
 * Deterministic replication consensus (spec §23): with replication_factor N,
 * accept when more than half of N results agree on the consensus fields; on
 * disagreement request one more replica, up to `maxReplicas`.
 */
export function evaluateConsensus(
  candidates: readonly ConsensusCandidate[],
  fields: readonly string[],
  replicationFactor: number,
  maxReplicas: number = LIMITS.maxReplicationFactor,
): ConsensusOutcome {
  const groups = new Map<string, string[]>();
  for (const c of candidates) {
    const key = consensusKey(c.result, fields);
    groups.set(key, [...(groups.get(key) ?? []), c.worker_id]);
  }

  const required = Math.max(replicationFactor, candidates.length);
  const majority = Math.floor(required / 2) + 1;
  for (const [key, workers] of groups) {
    if (workers.length >= majority) {
      const dissenting = candidates.map((c) => c.worker_id).filter((w) => !workers.includes(w));
      return { status: 'accepted', key, agreeing: workers, dissenting };
    }
  }

  if (candidates.length < replicationFactor) {
    return { status: 'pending', needed_replicas: replicationFactor };
  }
  if (candidates.length >= maxReplicas) return { status: 'unresolved' };
  return { status: 'pending', needed_replicas: candidates.length + 1 };
}
