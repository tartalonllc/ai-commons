import Type, { type Static } from 'typebox';
import {
  JsonObject,
  LeaseId,
  ModelName,
  NonNegativeInt,
  ProjectId,
  ProviderId,
  SemVer,
  TaskId,
  Timestamp,
  WorkerId,
} from './common.js';
import { LIMITS } from './limits.js';
import { ProjectCategory, ProjectRequirements } from './project.js';

export const TaskStatus = Type.Union([
  Type.Literal('PENDING'),
  Type.Literal('LEASED'),
  Type.Literal('COMPLETED'),
  Type.Literal('FAILED'),
  Type.Literal('CANCELLED'),
]);
export type TaskStatus = Static<typeof TaskStatus>;

export const TaskInput = Type.Object(
  {
    id: Type.Optional(TaskId),
    payload: JsonObject,
    priority: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
  },
  { additionalProperties: false },
);
export type TaskInput = Static<typeof TaskInput>;

export const CreateTasksRequest = Type.Object(
  {
    tasks: Type.Array(TaskInput, { minItems: 1, maxItems: LIMITS.maxTasksPerIngestBatch }),
  },
  { additionalProperties: false },
);
export type CreateTasksRequest = Static<typeof CreateTasksRequest>;

export const CreateTasksResponse = Type.Object(
  {
    created: NonNegativeInt,
    task_ids: Type.Array(TaskId),
  },
  { additionalProperties: false },
);
export type CreateTasksResponse = Static<typeof CreateTasksResponse>;

export const LeaseRequest = Type.Object(
  {
    worker_id: WorkerId,
    capabilities: Type.Object(
      {
        text_generation: Type.Boolean(),
        /** True when the worker can serve `local_models_only` tasks. */
        local_inference: Type.Boolean(),
        max_context_window: Type.Integer({ minimum: 1 }),
      },
      { additionalProperties: false },
    ),
    /** Volunteer's project preferences; omitted means all approved projects. */
    categories: Type.Optional(Type.Array(ProjectCategory, { minItems: 1, maxItems: 16 })),
  },
  { additionalProperties: false },
);
export type LeaseRequest = Static<typeof LeaseRequest>;

export const LeasedTask = Type.Object(
  {
    id: TaskId,
    lease_id: LeaseId,
    project_id: ProjectId,
    /** Lets workers detect a stale cached project definition. */
    project_version: SemVer,
    payload: JsonObject,
    requirements: ProjectRequirements,
    expires_at: Timestamp,
  },
  { additionalProperties: false },
);
export type LeasedTask = Static<typeof LeasedTask>;

export const LeaseResponse = Type.Object(
  {
    task: Type.Union([LeasedTask, Type.Null()]),
    /** When no task is available, how long the worker should wait before polling again. */
    retry_after_ms: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);
export type LeaseResponse = Static<typeof LeaseResponse>;

export const ExtendLeaseRequest = Type.Object(
  {
    worker_id: WorkerId,
    lease_id: LeaseId,
  },
  { additionalProperties: false },
);
export type ExtendLeaseRequest = Static<typeof ExtendLeaseRequest>;

export const ExtendLeaseResponse = Type.Object(
  {
    lease_id: LeaseId,
    expires_at: Timestamp,
  },
  { additionalProperties: false },
);
export type ExtendLeaseResponse = Static<typeof ExtendLeaseResponse>;

export const ExecutionMetrics = Type.Object(
  {
    duration_ms: Type.Integer({ minimum: 0, maximum: LIMITS.maxTaskRuntimeMs }),
    input_tokens: Type.Optional(NonNegativeInt),
    output_tokens: Type.Optional(NonNegativeInt),
    /** Actual spend reported by the worker's local accounting; absent for local providers. */
    cost_usd: Type.Optional(Type.Number({ minimum: 0 })),
  },
  { additionalProperties: false },
);
export type ExecutionMetrics = Static<typeof ExecutionMetrics>;

export const ResultSubmission = Type.Object(
  {
    worker_id: WorkerId,
    lease_id: LeaseId,
    provider: ProviderId,
    model: ModelName,
    result: JsonObject,
    metrics: ExecutionMetrics,
  },
  { additionalProperties: false },
);
export type ResultSubmission = Static<typeof ResultSubmission>;

export const ResultSubmissionStatus = Type.Union([
  Type.Literal('accepted'),
  Type.Literal('duplicate'),
  Type.Literal('rejected'),
]);
export type ResultSubmissionStatus = Static<typeof ResultSubmissionStatus>;

export const ResultSubmissionResponse = Type.Object(
  {
    status: ResultSubmissionStatus,
    reason: Type.Optional(Type.String({ maxLength: 500 })),
  },
  { additionalProperties: false },
);
export type ResultSubmissionResponse = Static<typeof ResultSubmissionResponse>;

export const FailureReason = Type.Union([
  Type.Literal('provider_error'),
  Type.Literal('timeout'),
  Type.Literal('invalid_output'),
  Type.Literal('budget_exceeded'),
  Type.Literal('limit_exceeded'),
  Type.Literal('cancelled'),
  Type.Literal('other'),
]);
export type FailureReason = Static<typeof FailureReason>;

export const TaskFailRequest = Type.Object(
  {
    worker_id: WorkerId,
    lease_id: LeaseId,
    reason: FailureReason,
    message: Type.Optional(Type.String({ maxLength: LIMITS.maxFailureMessageChars })),
    attempts: Type.Integer({ minimum: 1, maximum: 10 }),
  },
  { additionalProperties: false },
);
export type TaskFailRequest = Static<typeof TaskFailRequest>;

export const ProjectStats = Type.Object(
  {
    project_id: ProjectId,
    tasks_total: NonNegativeInt,
    tasks_pending: NonNegativeInt,
    tasks_leased: NonNegativeInt,
    tasks_completed: NonNegativeInt,
    tasks_failed: NonNegativeInt,
    contributors: NonNegativeInt,
    api_cost_usd: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type ProjectStats = Static<typeof ProjectStats>;
