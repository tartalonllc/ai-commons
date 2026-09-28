import {
  API_PREFIX,
  ApiError,
  CreateTasksResponse,
  jsonByteLength,
  LIMITS,
  parse,
  Project,
  ProjectStats,
  type ProjectDefinition,
  type TaskInput,
  type ValidationIssue,
} from '@ai-commons/protocol';
import type { Static, TSchema } from 'typebox';
import Value from 'typebox/value';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface AdminClientOptions {
  baseUrl: string;
  adminToken: string;
  fetch?: FetchLike;
}

export class CoordinatorAdminError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(`Coordinator returned ${status} (${code}): ${message}`);
    this.name = 'CoordinatorAdminError';
  }
}

export class TaskPayloadError extends Error {
  constructor(
    readonly index: number,
    readonly issues: ValidationIssue[],
  ) {
    super(`Task #${index} is invalid: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`);
    this.name = 'TaskPayloadError';
  }
}

export interface IngestOptions {
  /** Skip invalid payloads (reported in the result) instead of throwing. */
  skipInvalid?: boolean;
  batchSize?: number;
  onBatch?: (progress: { created: number; skipped: number }) => void;
}

export interface IngestResult {
  created: number;
  task_ids: string[];
  skipped: { index: number; issues: ValidationIssue[] }[];
}

export function checkTaskPayload(inputSchema: TSchema, task: TaskInput): ValidationIssue[] {
  if (jsonByteLength(task.payload) > LIMITS.maxPayloadBytes) {
    return [{ path: '/payload', message: `payload exceeds ${LIMITS.maxPayloadBytes} bytes` }];
  }
  if (Value.Check(inputSchema, task.payload)) return [];
  return Value.Errors(inputSchema, task.payload)
    .slice(0, 10)
    .map((e) => ({ path: `/payload${e.instancePath}`, message: e.message }));
}

/** Administrative client for project owners. Never sent worker or provider credentials. */
export class CoordinatorAdminClient {
  private readonly baseUrl: string;
  private readonly adminToken: string;
  private readonly fetchFn: FetchLike;

  constructor(options: AdminClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '') + API_PREFIX;
    this.adminToken = options.adminToken;
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async createProject(definition: ProjectDefinition): Promise<Project> {
    return this.request('POST', '/projects', Project, definition);
  }

  async getProject(projectId: string): Promise<Project> {
    return this.request('GET', `/projects/${encodeURIComponent(projectId)}`, Project);
  }

  async getProjectStats(projectId: string): Promise<ProjectStats> {
    return this.request('GET', `/projects/${encodeURIComponent(projectId)}/stats`, ProjectStats);
  }

  /**
   * Validates each payload against the project's input schema and size limit,
   * then submits in batches. Batches already sent are not rolled back if a
   * later task is invalid and `skipInvalid` is false.
   */
  async ingestTasks(
    project: Pick<ProjectDefinition, 'id' | 'input_schema'>,
    tasks: Iterable<TaskInput> | AsyncIterable<TaskInput>,
    options: IngestOptions = {},
  ): Promise<IngestResult> {
    const batchSize = Math.min(
      options.batchSize ?? LIMITS.maxTasksPerIngestBatch,
      LIMITS.maxTasksPerIngestBatch,
    );
    const schema = project.input_schema as TSchema;
    const path = `/projects/${encodeURIComponent(project.id)}/tasks`;
    const result: IngestResult = { created: 0, task_ids: [], skipped: [] };
    let batch: TaskInput[] = [];

    const flush = async () => {
      if (batch.length === 0) return;
      const response = await this.request('POST', path, CreateTasksResponse, { tasks: batch });
      result.created += response.created;
      result.task_ids.push(...response.task_ids);
      batch = [];
      options.onBatch?.({ created: result.created, skipped: result.skipped.length });
    };

    let index = 0;
    for await (const task of tasks) {
      const issues = checkTaskPayload(schema, task);
      if (issues.length > 0) {
        if (!options.skipInvalid) throw new TaskPayloadError(index, issues);
        result.skipped.push({ index, issues });
      } else {
        batch.push(task);
        if (batch.length >= batchSize) await flush();
      }
      index++;
    }
    await flush();
    return result;
  }

  private async request<S extends TSchema>(
    method: 'GET' | 'POST',
    path: string,
    responseSchema: S,
    body?: unknown,
  ): Promise<Static<S>> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.adminToken}` };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await this.fetchFn(this.baseUrl + path, init);
    const text = await response.text();
    let json: unknown;
    try {
      json = text === '' ? undefined : JSON.parse(text);
    } catch {
      json = undefined;
    }

    if (!response.ok) {
      const error = parse(ApiError, json);
      if (error.ok) {
        throw new CoordinatorAdminError(
          response.status,
          error.value.error.code,
          error.value.error.message,
        );
      }
      throw new CoordinatorAdminError(
        response.status,
        'unknown',
        response.statusText || 'request failed',
      );
    }

    const parsed = parse(responseSchema, json);
    if (!parsed.ok) {
      const detail = parsed.issues.map((i) => `${i.path}: ${i.message}`).join('; ');
      throw new CoordinatorAdminError(response.status, 'invalid_response', detail);
    }
    return parsed.value;
  }
}
