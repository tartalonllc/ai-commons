import Type, { type Static } from 'typebox';
import { NonNegativeInt, ProjectId, Timestamp, WorkerId } from './common.js';
import { WorkerStatus } from './worker.js';

export const Metrics = Type.Object(
  {
    worker_count: NonNegativeInt,
    active_worker_count: NonNegativeInt,
    task_queue_depth: NonNegativeInt,
    task_completion_rate: Type.Number({ minimum: 0, maximum: 1 }),
    task_failure_rate: Type.Number({ minimum: 0, maximum: 1 }),
    average_task_duration_ms: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type Metrics = Static<typeof Metrics>;

export const NetworkProjectSummary = Type.Object(
  {
    id: ProjectId,
    name: Type.String(),
    tasks_total: NonNegativeInt,
    tasks_completed: NonNegativeInt,
    progress: Type.Number({ minimum: 0, maximum: 1 }),
    workers: NonNegativeInt,
  },
  { additionalProperties: false },
);
export type NetworkProjectSummary = Static<typeof NetworkProjectSummary>;

export const NetworkWorkerSummary = Type.Object(
  {
    worker_id: WorkerId,
    status: WorkerStatus,
    tasks_completed: NonNegativeInt,
    last_seen: Timestamp,
  },
  { additionalProperties: false },
);
export type NetworkWorkerSummary = Static<typeof NetworkWorkerSummary>;

/** Public dashboard summary (§37). Contains no IPs, providers, or machine details (§52). */
export const NetworkSummary = Type.Object(
  {
    network: Type.Object(
      {
        connected_workers: NonNegativeInt,
        active_workers: NonNegativeInt,
        tasks_waiting: NonNegativeInt,
        tasks_processing: NonNegativeInt,
        tasks_completed: NonNegativeInt,
        tasks_failed: NonNegativeInt,
      },
      { additionalProperties: false },
    ),
    compute: Type.Object(
      {
        input_tokens: NonNegativeInt,
        output_tokens: NonNegativeInt,
        local_inference_hours: Type.Number({ minimum: 0 }),
        api_cost_usd: Type.Number({ minimum: 0 }),
        ai_compute_units: Type.Number({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    projects: Type.Array(NetworkProjectSummary),
    workers: Type.Array(NetworkWorkerSummary),
    generated_at: Timestamp,
  },
  { additionalProperties: false },
);
export type NetworkSummary = Static<typeof NetworkSummary>;
