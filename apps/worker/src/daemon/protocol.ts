import { parse, ProviderId, type ValidationIssue } from '@ai-commons/protocol';
import Type, { type Static } from 'typebox';
import { ScheduleMode } from '../config.js';
import type { LocalTotals } from '../stats.js';
import type { CurrentTask } from '../runner.js';

/**
 * Newline-delimited JSON over stdio between the desktop shell and the worker
 * daemon. Mirrored by `MAX_LINE_BYTES` in apps/desktop/src-tauri/src/framing.rs.
 */
export const DAEMON_MAX_LINE_BYTES = 1_000_000;

export const RequestEnvelope = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 64 }),
    method: Type.String({ minLength: 1, maxLength: 64 }),
    params: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

const Empty = Type.Object({}, { additionalProperties: false });

export const MethodParams = {
  getStatus: Empty,
  getConfig: Empty,
  saveConfig: Type.Object({ config: Type.Unknown() }, { additionalProperties: false }),
  setMode: Type.Object({ mode: ScheduleMode }, { additionalProperties: false }),
  resume: Empty,
  setKey: Type.Object(
    { provider: ProviderId, key: Type.String({ minLength: 1, maxLength: 4096 }) },
    { additionalProperties: false },
  ),
  deleteKey: Type.Object({ provider: ProviderId }, { additionalProperties: false }),
  probeProvider: Type.Object(
    { id: ProviderId, endpoint: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })) },
    { additionalProperties: false },
  ),
  /** Sent by the desktop shell only; the webview cannot call it. */
  setIdle: Type.Object({ idle: Type.Boolean() }, { additionalProperties: false }),
  shutdown: Empty,
} as const;

export type DaemonMethod = keyof typeof MethodParams;
export type MethodParamsOf<M extends DaemonMethod> = Static<(typeof MethodParams)[M]>;

export type DaemonErrorCode =
  'bad_request' | 'unknown_method' | 'invalid_config' | 'unavailable' | 'internal';

export interface ProviderStatus {
  id: string;
  kind: 'local' | 'remote';
  display_name: string;
  enabled: boolean;
  /** null until the worker has checked providers. */
  healthy: boolean | null;
  requires_key: boolean;
  has_key: boolean;
}

export interface DaemonStatus {
  connection: 'connected' | 'connecting' | 'offline' | 'unconfigured';
  worker_id?: string;
  coordinator_url: string;
  mode: ScheduleMode;
  idle: boolean;
  idle_after_minutes: number;
  current?: CurrentTask;
  today: LocalTotals;
  month: LocalTotals;
  providers: ProviderStatus[];
  limits: { daily_usd: number; monthly_usd: number };
  /** Always passed through scrubSecrets(). */
  last_error?: string;
}

export interface ProbeResult {
  ok: boolean;
  message?: string;
  models: { name: string; context_window?: number }[];
}

export type DaemonResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string | null; ok: false; error: { code: DaemonErrorCode; message: string } };

export interface DaemonEvent {
  event: 'status';
  data: DaemonStatus;
}

export type ParsedRequest =
  | { ok: true; id: string; method: DaemonMethod; params: unknown }
  | { ok: false; id: string | null; code: DaemonErrorCode; message: string };

function isMethod(name: string): name is DaemonMethod {
  return Object.hasOwn(MethodParams, name);
}

function describeIssues(issues: ValidationIssue[]): string {
  return issues
    .slice(0, 3)
    .map((i) => `${i.path}: ${i.message}`)
    .join('; ');
}

/** Validates one inbound line. Never throws. */
export function parseRequestLine(line: string): ParsedRequest {
  if (Buffer.byteLength(line, 'utf8') > DAEMON_MAX_LINE_BYTES) {
    return { ok: false, id: null, code: 'bad_request', message: 'Request is too large' };
  }
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return { ok: false, id: null, code: 'bad_request', message: 'Request is not valid JSON' };
  }
  const envelope = parse(RequestEnvelope, json);
  if (!envelope.ok) {
    return {
      ok: false,
      id: null,
      code: 'bad_request',
      message: `Invalid request: ${describeIssues(envelope.issues)}`,
    };
  }
  const { id, method } = envelope.value;
  if (!isMethod(method)) {
    return { ok: false, id, code: 'unknown_method', message: `Unknown method "${method}"` };
  }
  const params = parse(MethodParams[method], envelope.value.params ?? {});
  if (!params.ok) {
    return {
      ok: false,
      id,
      code: 'bad_request',
      message: `Invalid params: ${describeIssues(params.issues)}`,
    };
  }
  return { ok: true, id, method, params: params.value };
}
