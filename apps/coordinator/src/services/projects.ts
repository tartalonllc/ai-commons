import {
  jsonByteLength,
  LIMITS,
  templatePlaceholders,
  type CreateTasksRequest,
  type CreateTasksResponse,
  type Project,
  type ProjectCategory,
  type ProjectDefinition,
  type ProjectStats,
  type ProjectStatus,
} from '@ai-commons/protocol';
import { checkProjectSchema } from '@ai-commons/validators';
import { eq, ne, sql } from 'drizzle-orm';
import Value from 'typebox/value';
import type { Database, Executor } from '../db/client.js';
import { projects, tasks } from '../db/schema.js';
import { HttpError } from '../errors.js';
import { newTaskId } from '../ids.js';

export type ProjectRow = typeof projects.$inferSelect;

export function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    version: row.version,
    category: row.category as ProjectCategory,
    input_schema: row.inputSchema,
    output_schema: row.outputSchema,
    prompt: row.prompt,
    requirements: row.requirements,
    validation: row.validation,
    status: row.status as ProjectStatus,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function schemaProperties(schema: Record<string, unknown>): Set<string> {
  const props = schema['properties'];
  return new Set(typeof props === 'object' && props !== null ? Object.keys(props) : []);
}

function validateDefinition(def: ProjectDefinition): void {
  const issues = [
    ...checkProjectSchema(def.input_schema).map((i) => `input_schema${i.path}: ${i.message}`),
    ...checkProjectSchema(def.output_schema).map((i) => `output_schema${i.path}: ${i.message}`),
  ];

  const inputFields = schemaProperties(def.input_schema);
  for (const field of [
    ...templatePlaceholders(def.prompt.system),
    ...templatePlaceholders(def.prompt.user),
  ]) {
    if (!inputFields.has(field))
      issues.push(`prompt placeholder {{${field}}} is not an input_schema property`);
  }

  const outputFields = schemaProperties(def.output_schema);
  for (const field of def.validation.consensus_fields ?? []) {
    if (!outputFields.has(field))
      issues.push(`consensus field "${field}" is not an output_schema property`);
  }
  if (def.validation.mode === 'consensus') {
    if (def.validation.replication_factor < 2) {
      issues.push('consensus validation requires replication_factor >= 2');
    }
    if ((def.validation.consensus_fields ?? []).length === 0) {
      issues.push('consensus validation requires non-empty consensus_fields');
    }
  }

  if (issues.length > 0) throw new HttpError('bad_request', issues.slice(0, 10).join('; '));
}

export async function createProject(db: Database, def: ProjectDefinition): Promise<Project> {
  validateDefinition(def);
  const rows = await db
    .insert(projects)
    .values({
      id: def.id,
      name: def.name,
      description: def.description,
      version: def.version,
      category: def.category,
      inputSchema: def.input_schema,
      outputSchema: def.output_schema,
      prompt: def.prompt,
      requirements: def.requirements,
      validation: def.validation,
      localModelsOnly: def.requirements.local_models_only,
      minimumContextWindow: def.requirements.minimum_context_window,
      validationMode: def.validation.mode,
      replicationFactor: def.validation.replication_factor,
    })
    .onConflictDoNothing()
    .returning();
  const row = rows[0];
  if (!row) throw new HttpError('conflict', `Project "${def.id}" already exists`);
  return toProject(row);
}

export async function listProjects(db: Database): Promise<Project[]> {
  const rows = await db
    .select()
    .from(projects)
    .where(ne(projects.status, 'archived'))
    .orderBy(projects.createdAt);
  return rows.map(toProject);
}

export async function getProjectRow(db: Executor, id: string): Promise<ProjectRow> {
  const [row] = await db.select().from(projects).where(eq(projects.id, id));
  if (!row) throw new HttpError('not_found', `Project "${id}" not found`);
  return row;
}

export async function ingestTasks(
  db: Database,
  projectId: string,
  request: CreateTasksRequest,
): Promise<CreateTasksResponse> {
  const project = await getProjectRow(db, projectId);
  if (project.status === 'archived') throw new HttpError('conflict', 'Project is archived');

  const rows = request.tasks.map((task, index) => {
    if (jsonByteLength(task.payload) > LIMITS.maxPayloadBytes) {
      throw new HttpError(
        'payload_too_large',
        `tasks[${index}].payload exceeds ${LIMITS.maxPayloadBytes} bytes`,
      );
    }
    if (!Value.Check(project.inputSchema, task.payload)) {
      const first = Value.Errors(project.inputSchema, task.payload)[0];
      const where = first ? `${first.instancePath || '/'}: ${first.message}` : 'invalid';
      throw new HttpError(
        'bad_request',
        `tasks[${index}].payload does not match input_schema (${where})`,
      );
    }
    return {
      id: task.id ?? newTaskId(),
      projectId,
      payload: task.payload,
      priority: task.priority ?? 0,
      replicationFactor: project.replicationFactor,
    };
  });

  const ids = new Set(rows.map((r) => r.id));
  if (ids.size !== rows.length) throw new HttpError('bad_request', 'Duplicate task ids in batch');

  const inserted = await db.transaction(async (tx) => {
    const result = await tx
      .insert(tasks)
      .values(rows)
      .onConflictDoNothing()
      .returning({ id: tasks.id });
    if (result.length !== rows.length) {
      throw new HttpError('conflict', 'One or more task ids already exist; batch rejected');
    }
    return result;
  });
  return { created: inserted.length, task_ids: rows.map((r) => r.id) };
}

export async function projectStats(db: Database, projectId: string): Promise<ProjectStats> {
  await getProjectRow(db, projectId);
  const result = await db.execute<{
    total: string;
    pending: string;
    leased: string;
    completed: string;
    failed: string;
  }>(sql`
    SELECT count(*) AS total,
           count(*) FILTER (WHERE status = 'PENDING') AS pending,
           count(*) FILTER (WHERE status = 'LEASED') AS leased,
           count(*) FILTER (WHERE status = 'COMPLETED') AS completed,
           count(*) FILTER (WHERE status = 'FAILED') AS failed
    FROM tasks WHERE project_id = ${projectId}`);
  const contrib = await db.execute<{ contributors: string; cost: number | null }>(sql`
    SELECT count(DISTINCT r.worker_id) AS contributors, sum(r.cost_usd) AS cost
    FROM results r JOIN tasks t ON t.id = r.task_id
    WHERE t.project_id = ${projectId}`);
  const c = result.rows[0];
  const k = contrib.rows[0];
  return {
    project_id: projectId,
    tasks_total: Number(c?.total ?? 0),
    tasks_pending: Number(c?.pending ?? 0),
    tasks_leased: Number(c?.leased ?? 0),
    tasks_completed: Number(c?.completed ?? 0),
    tasks_failed: Number(c?.failed ?? 0),
    contributors: Number(k?.contributors ?? 0),
    api_cost_usd: Number(k?.cost ?? 0),
  };
}
