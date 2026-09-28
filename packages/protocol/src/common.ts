import Type, { type Static } from 'typebox';

export const WorkerId = Type.String({ pattern: '^worker_[a-z0-9]{5,32}$' });
export type WorkerId = Static<typeof WorkerId>;

export const TaskId = Type.String({ pattern: '^[A-Za-z0-9_-]{1,64}$' });
export type TaskId = Static<typeof TaskId>;

export const LeaseId = Type.String({ pattern: '^lease_[A-Za-z0-9]{8,64}$' });
export type LeaseId = Static<typeof LeaseId>;

export const ProjectId = Type.String({ pattern: '^[a-z0-9][a-z0-9-]{1,62}$' });
export type ProjectId = Static<typeof ProjectId>;

export const ProviderId = Type.String({ pattern: '^[a-z0-9][a-z0-9_-]{0,31}$' });
export type ProviderId = Static<typeof ProviderId>;

export const ModelName = Type.String({ minLength: 1, maxLength: 128 });
export type ModelName = Static<typeof ModelName>;

export const SemVer = Type.String({ pattern: '^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$' });
export type SemVer = Static<typeof SemVer>;

export const Timestamp = Type.String({ format: 'date-time' });
export type Timestamp = Static<typeof Timestamp>;

/** A JSON object whose shape is defined elsewhere (e.g. by a project's JSON Schema). */
export const JsonObject = Type.Record(Type.String(), Type.Unknown());
export type JsonObject = Static<typeof JsonObject>;

/** A JSON Schema document supplied by a project owner. Structural checks happen at ingestion. */
export const JsonSchemaDocument = Type.Record(Type.String(), Type.Unknown());
export type JsonSchemaDocument = Static<typeof JsonSchemaDocument>;

export const NonNegativeInt = Type.Integer({ minimum: 0 });
