import { parse, ProviderId, type ValidationIssue } from '@ai-commons/protocol';
import Type, { type Static } from 'typebox';
import { ScheduleMode } from '../config.js';
import type { LocalTotals } from '../stats.js';
import type { CurrentTask } from '../runner.js';

/**
 * Newline-delimited JSON over stdio between the desktop shell and the worker
 * daemon. Mirrored by `MAX_LINE_BYTES` in apps/desktop/src-tauri/src/framing.rs.
 *
 * This cap is a backstop, not the primary defense: `readline` buffers an
 * entire line into memory before `parseRequestLine` ever sees it, so the size
 * check below runs only after that allocation already happened. The only
 * peer expected on the other end of this pipe is the Rust shell, which caps
 * its own writes to this same limit. Do not expose the daemon's stdin to a
 * less-trusted peer.
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
  /** `config` is untrusted until validateConfig; do not log or serialize raw params. */
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

/** Ties `method` to `params` so `switch (req.method)` narrows `req.params` with no cast. */
export type ValidRequest = {
  [M in DaemonMethod]: { ok: true; id: string; method: M; params: MethodParamsOf<M> };
}[DaemonMethod];

export type ParsedRequest =
  ValidRequest | { ok: false; id: string | null; code: DaemonErrorCode; message: string };

function isMethod(name: string): name is DaemonMethod {
  return Object.hasOwn(MethodParams, name);
}

function describeIssues(issues: ValidationIssue[]): string {
  return issues
    .slice(0, 3)
    .map((i) => `${i.path}: ${i.message}`)
    .join('; ');
}

/**
 * Best-effort id recovery for a request whose envelope failed validation, so
 * the caller can still match the error to the request it sent. Returns null
 * for anything that isn't a plain object with a usable `id` string.
 */
function extractId(json: unknown): string | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
  if (!Object.hasOwn(json, 'id')) return null;
  const { id } = json as Record<string, unknown>;
  if (typeof id !== 'string' || id.length < 1 || id.length > 64) return null;
  return id;
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
      id: extractId(json),
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
  // Safe: `params.value` was just validated against `MethodParams[method]`, so it
  // matches `MethodParamsOf<typeof method>` for this specific `method`.
  return { ok: true, id, method, params: params.value } as ValidRequest;
}
