import type {
  JsonObject,
  JsonSchemaDocument,
  PromptTemplate,
  ProjectRequirements,
  ProjectValidation,
} from '@ai-commons/protocol';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  version: text('version').notNull(),
  category: text('category').notNull(),
  inputSchema: jsonb('input_schema').$type<JsonSchemaDocument>().notNull(),
  outputSchema: jsonb('output_schema').$type<JsonSchemaDocument>().notNull(),
  prompt: jsonb('prompt').$type<PromptTemplate>().notNull(),
  requirements: jsonb('requirements').$type<ProjectRequirements>().notNull(),
  validation: jsonb('validation').$type<ProjectValidation>().notNull(),
  // Denormalized from `requirements`/`validation` so leasing can filter in SQL.
  localModelsOnly: boolean('local_models_only').notNull(),
  minimumContextWindow: integer('minimum_context_window').notNull(),
  validationMode: text('validation_mode').notNull(),
  replicationFactor: integer('replication_factor').notNull(),
  status: text('status').notNull().default('active'),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const workers = pgTable('workers', {
  id: text('id').primaryKey(),
  secretHash: text('secret_hash').notNull(),
  platform: text('platform').notNull(),
  clientVersion: text('client_version').notNull(),
  protocolVersion: text('protocol_version').notNull(),
  status: text('status').notNull().default('available'),
  currentTasks: integer('current_tasks').notNull().default(0),
  disabled: boolean('disabled').notNull().default(false),
  createdAt: createdAt(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
});

export const workerCapabilities = pgTable(
  'worker_capabilities',
  {
    workerId: text('worker_id')
      .notNull()
      .references(() => workers.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    kind: text('kind').notNull(),
    models: jsonb('models').$type<{ name: string; context_window?: number }[]>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.workerId, t.provider] })],
);

export const tasks = pgTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    payload: jsonb('payload').$type<JsonObject>().notNull(),
    status: text('status').notNull().default('PENDING'),
    priority: integer('priority').notNull().default(0),
    /** Replicas currently required; grows when consensus needs a tie-breaker. */
    replicationFactor: integer('replication_factor').notNull(),
    /** Maintained counters: leasing filters on these so row-lock rechecks see fresh values. */
    activeLeases: integer('active_leases').notNull().default(0),
    completedReplicas: integer('completed_replicas').notNull().default(0),
    failureCount: integer('failure_count').notNull().default(0),
    consensusKey: text('consensus_key'),
    acceptedResultId: text('accepted_result_id'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    index('tasks_leasable_idx').on(t.status, t.priority, t.createdAt),
    index('tasks_project_idx').on(t.projectId, t.status),
    check(
      'tasks_counters_nonnegative',
      sql`${t.activeLeases} >= 0 AND ${t.completedReplicas} >= 0`,
    ),
  ],
);

export const taskLeases = pgTable(
  'task_leases',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id),
    workerId: text('worker_id')
      .notNull()
      .references(() => workers.id),
    leasedAt: timestamp('leased_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** active | completed | rejected | failed | expired */
    status: text('status').notNull().default('active'),
  },
  (t) => [
    // A task is never leased to the same worker twice: keeps replicas independent.
    uniqueIndex('task_leases_task_worker_uq').on(t.taskId, t.workerId),
    index('task_leases_active_expiry_idx')
      .on(t.expiresAt)
      .where(sql`${t.status} = 'active'`),
    index('task_leases_worker_idx').on(t.workerId),
  ],
);

export const results = pgTable(
  'results',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id),
    workerId: text('worker_id')
      .notNull()
      .references(() => workers.id),
    leaseId: text('lease_id')
      .notNull()
      .references(() => taskLeases.id),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    result: jsonb('result').$type<JsonObject>().notNull(),
    resultHash: text('result_hash').notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    durationMs: integer('duration_ms').notNull(),
    costUsd: doublePrecision('cost_usd'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('results_task_worker_uq').on(t.taskId, t.workerId)],
);

export const validations = pgTable(
  'validations',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id),
    workerId: text('worker_id').references(() => workers.id),
    /** rejected_output | accepted | pending | unresolved */
    outcome: text('outcome').notNull(),
    detail: jsonb('detail').$type<JsonObject>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('validations_task_idx').on(t.taskId)],
);

export const contributions = pgTable('contributions', {
  workerId: text('worker_id')
    .primaryKey()
    .references(() => workers.id),
  tasksCompleted: integer('tasks_completed').notNull().default(0),
  tasksValidated: integer('tasks_validated').notNull().default(0),
  inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
  outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
  localInferenceMs: bigint('local_inference_ms', { mode: 'number' }).notNull().default(0),
  totalExecutionMs: bigint('total_execution_ms', { mode: 'number' }).notNull().default(0),
  apiCostUsd: doublePrecision('api_cost_usd').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
