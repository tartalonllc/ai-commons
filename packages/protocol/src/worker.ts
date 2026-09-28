import Type, { type Static } from 'typebox';
import { ModelName, NonNegativeInt, ProviderId, SemVer, Timestamp, WorkerId } from './common.js';

export const Platform = Type.Union([
  Type.Literal('windows'),
  Type.Literal('macos'),
  Type.Literal('linux'),
  Type.Literal('other'),
]);
export type Platform = Static<typeof Platform>;

/** `local` providers run on the volunteer's hardware; `remote` ones send data to a third party. */
export const ProviderKind = Type.Union([Type.Literal('local'), Type.Literal('remote')]);
export type ProviderKind = Static<typeof ProviderKind>;

export const ModelCapability = Type.Object(
  {
    name: ModelName,
    context_window: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);
export type ModelCapability = Static<typeof ModelCapability>;

export const ProviderCapability = Type.Object(
  {
    provider: ProviderId,
    kind: ProviderKind,
    models: Type.Array(ModelCapability, { minItems: 1, maxItems: 64 }),
  },
  { additionalProperties: false },
);
export type ProviderCapability = Static<typeof ProviderCapability>;

export const WorkerCapabilities = Type.Object(
  {
    platform: Platform,
    client_version: SemVer,
    providers: Type.Array(ProviderCapability, { minItems: 1, maxItems: 16 }),
  },
  { additionalProperties: false },
);
export type WorkerCapabilities = Static<typeof WorkerCapabilities>;

export const RegisterWorkerRequest = Type.Object(
  {
    protocol_version: SemVer,
    capabilities: WorkerCapabilities,
  },
  { additionalProperties: false },
);
export type RegisterWorkerRequest = Static<typeof RegisterWorkerRequest>;

/** `worker_secret` is shown once; the coordinator stores only a hash of it. */
export const RegisterWorkerResponse = Type.Object(
  {
    worker_id: WorkerId,
    worker_secret: Type.String({ minLength: 32 }),
    heartbeat_interval_ms: Type.Integer({ minimum: 1_000 }),
    lease_duration_ms: Type.Integer({ minimum: 1_000 }),
  },
  { additionalProperties: false },
);
export type RegisterWorkerResponse = Static<typeof RegisterWorkerResponse>;

export const UpdateCapabilitiesRequest = Type.Object(
  {
    worker_id: WorkerId,
    capabilities: WorkerCapabilities,
  },
  { additionalProperties: false },
);
export type UpdateCapabilitiesRequest = Static<typeof UpdateCapabilitiesRequest>;

export const WorkerStatus = Type.Union([
  Type.Literal('available'),
  Type.Literal('busy'),
  Type.Literal('paused'),
]);
export type WorkerStatus = Static<typeof WorkerStatus>;

export const HeartbeatRequest = Type.Object(
  {
    worker_id: WorkerId,
    status: WorkerStatus,
    providers: Type.Array(ProviderId, { maxItems: 16 }),
    current_tasks: Type.Integer({ minimum: 0, maximum: 64 }),
  },
  { additionalProperties: false },
);
export type HeartbeatRequest = Static<typeof HeartbeatRequest>;

export const HeartbeatResponse = Type.Object(
  {
    server_time: Timestamp,
  },
  { additionalProperties: false },
);
export type HeartbeatResponse = Static<typeof HeartbeatResponse>;

/**
 * Local inference and paid API usage are reported separately: ACUs are only
 * derived from real API cost, per the "do not fake precision" rule.
 */
export const WorkerStats = Type.Object(
  {
    worker_id: WorkerId,
    tasks_completed: NonNegativeInt,
    tasks_validated: NonNegativeInt,
    input_tokens: NonNegativeInt,
    output_tokens: NonNegativeInt,
    local_inference_ms: NonNegativeInt,
    total_execution_ms: NonNegativeInt,
    api_cost_usd: Type.Number({ minimum: 0 }),
    ai_compute_units: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type WorkerStats = Static<typeof WorkerStats>;
