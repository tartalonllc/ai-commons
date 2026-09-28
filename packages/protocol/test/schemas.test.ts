import type { TSchema } from 'typebox';
import { describe, expect, it } from 'vitest';
import {
  CreateTasksRequest,
  HeartbeatRequest,
  LeaseRequest,
  LeaseResponse,
  LIMITS,
  parse,
  Project,
  ProjectDefinition,
  RegisterWorkerRequest,
  RegisterWorkerResponse,
  ResultSubmission,
  TaskFailRequest,
  WorkerId,
} from '../src/index.js';
import * as fx from './fixtures.js';

const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe('round-trip over JSON', () => {
  const cases: [string, TSchema, unknown][] = [
    ['ProjectDefinition', ProjectDefinition, fx.projectDefinition],
    ['Project', Project, fx.project],
    ['RegisterWorkerRequest', RegisterWorkerRequest, fx.registerRequest],
    ['RegisterWorkerResponse', RegisterWorkerResponse, fx.registerResponse],
    ['LeaseRequest', LeaseRequest, fx.leaseRequest],
    ['LeaseResponse', LeaseResponse, fx.leaseResponse],
    ['LeaseResponse (empty)', LeaseResponse, { task: null, retry_after_ms: 30_000 }],
    ['ResultSubmission', ResultSubmission, fx.resultSubmission],
    ['TaskFailRequest', TaskFailRequest, fx.failRequest],
  ];

  it.each(cases)('%s survives serialization and validates', (_name, schema, value) => {
    const received = wire(value);
    const parsed = parse(schema, received);
    expect(parsed).toEqual({ ok: true, value });
  });
});

describe('rejects malformed network input', () => {
  it('rejects unknown properties on requests', () => {
    const result = parse(ResultSubmission, { ...fx.resultSubmission, api_key: 'sk-leak' });
    expect(result.ok).toBe(false);
  });

  it('rejects invalid worker ids', () => {
    for (const id of ['worker_', 'WORKER_abcde', 'worker_ab', 'admin', 'worker_abcde; DROP']) {
      expect(parse(WorkerId, id).ok, id).toBe(false);
    }
  });

  it('rejects out-of-range replication factor', () => {
    const def = {
      ...fx.projectDefinition,
      validation: { mode: 'consensus', replication_factor: LIMITS.maxReplicationFactor + 1 },
    };
    expect(parse(ProjectDefinition, def).ok).toBe(false);
  });

  it('rejects oversized ingest batches', () => {
    const tasks = Array.from({ length: LIMITS.maxTasksPerIngestBatch + 1 }, () => ({
      payload: {},
    }));
    expect(parse(CreateTasksRequest, { tasks }).ok).toBe(false);
  });

  it('rejects runtimes over the task runtime limit', () => {
    const submission = {
      ...fx.resultSubmission,
      metrics: { duration_ms: LIMITS.maxTaskRuntimeMs + 1 },
    };
    expect(parse(ResultSubmission, submission).ok).toBe(false);
  });

  it('rejects non-ISO timestamps', () => {
    const response = { task: { ...fx.leaseResponse.task, expires_at: 'tomorrow' } };
    expect(parse(LeaseResponse, response).ok).toBe(false);
  });

  it('rejects unknown task status values in heartbeat', () => {
    const hb = { worker_id: 'worker_f4e82', status: 'mining', providers: [], current_tasks: 0 };
    expect(parse(HeartbeatRequest, hb).ok).toBe(false);
  });

  it('reports the path of each issue', () => {
    const result = parse(RegisterWorkerRequest, {
      protocol_version: '0.1.0',
      capabilities: { ...fx.registerRequest.capabilities, platform: 'amiga' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.path.startsWith('/capabilities/platform'))).toBe(true);
    }
  });
});
