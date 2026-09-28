import {
  API_PREFIX,
  CreateTasksRequest,
  CreateTasksResponse,
  ExtendLeaseRequest,
  ExtendLeaseResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  LeaseRequest,
  LeaseResponse,
  Project,
  ProjectDefinition,
  ProjectId,
  ProjectList,
  ProjectStats,
  RegisterWorkerRequest,
  RegisterWorkerResponse,
  ResultSubmission,
  ResultSubmissionResponse,
  TaskFailRequest,
  TaskId,
  TaskStatus,
  UpdateCapabilitiesRequest,
  WorkerId,
  WorkerStats,
} from '@ai-commons/protocol';
import rateLimit from '@fastify/rate-limit';
import { TypeBoxValidatorCompiler, type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from 'fastify';
import Type from 'typebox';
import { bearerToken, requireAdmin } from './auth.js';
import type { CoordinatorConfig } from './config.js';
import type { Database } from './db/client.js';
import { apiError, HttpError } from './errors.js';
import {
  collectMetrics,
  Metrics,
  NetworkSummary,
  networkSummary,
} from './services/observability.js';
import {
  createProject,
  getProjectRow,
  ingestTasks,
  listProjects,
  projectStats,
  toProject,
} from './services/projects.js';
import { extendLease, failTask, leaseTask, submitResult } from './services/tasks.js';
import {
  authenticateWorker,
  recordHeartbeat,
  registerWorker,
  touchWorker,
  updateCapabilities,
  workerStats,
} from './services/workers.js';

export interface AppOptions {
  config: CoordinatorConfig;
  db: Database;
  logger?: boolean;
}

/** Slightly above the 1 MB payload limit to leave room for JSON envelope overhead. */
const BODY_LIMIT = 1_150_000;

const TaskParams = Type.Object({ id: TaskId }, { additionalProperties: false });
const ProjectParams = Type.Object({ id: ProjectId }, { additionalProperties: false });
const WorkerParams = Type.Object({ id: WorkerId }, { additionalProperties: false });
const FailResponse = Type.Object({ task_status: TaskStatus }, { additionalProperties: false });
const Health = Type.Object({ status: Type.Literal('ok') }, { additionalProperties: false });

const PG_RETRYABLE = new Set(['40P01', '40001']);

async function withDeadlockRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (error) {
      const code =
        (error as { code?: unknown; cause?: { code?: unknown } }).code ??
        (error as { cause?: { code?: unknown } }).cause?.code;
      if (i >= attempts || typeof code !== 'string' || !PG_RETRYABLE.has(code)) throw error;
    }
  }
}

export async function buildApp({
  config,
  db,
  logger = true,
}: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: BODY_LIMIT,
    logger: logger && {
      level: config.logLevel,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          '*.worker_secret',
          '*.adminToken',
        ],
        censor: '[redacted]',
      },
    },
  })
    .setValidatorCompiler(TypeBoxValidatorCompiler)
    .withTypeProvider<TypeBoxTypeProvider>();

  app.setErrorHandler((error: FastifyError | HttpError, request, reply) => {
    if (error instanceof HttpError) {
      if (error.code === 'rate_limited') request.log.warn({ ip: request.ip }, 'rate limited');
      return reply.status(error.statusCode).send(error.toBody());
    }
    if (error.validation) {
      const detail = error.validation
        .slice(0, 5)
        .map((v) => `${v.instancePath || '/'} ${v.message ?? 'invalid'}`)
        .join('; ');
      return reply.status(400).send(apiError('bad_request', `Invalid request: ${detail}`));
    }
    const status = error.statusCode ?? 500;
    if (status === 413)
      return reply.status(413).send(apiError('payload_too_large', 'Request body too large'));
    if (status >= 400 && status < 500) {
      return reply.status(status).send(apiError('bad_request', error.message));
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send(apiError('internal_error', 'Internal server error'));
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send(apiError('not_found', 'Route not found')),
  );

  if (config.rateLimit) {
    await app.register(rateLimit, {
      global: true,
      max: config.rateLimit.max,
      timeWindow: '1 minute',
      errorResponseBuilder: (_request, context) =>
        new HttpError('rate_limited', `Rate limit exceeded; retry in ${context.after}`),
    });
  }

  // Runs after schema validation, so body.worker_id is a well-formed WorkerId.
  const authWorker = async (request: FastifyRequest) => {
    const { worker_id } = request.body as { worker_id: string };
    await authenticateWorker(db, worker_id, bearerToken(request));
  };
  const authAdmin = async (request: FastifyRequest) => requireAdmin(request, config.adminToken);

  app.get('/healthz', { schema: { response: { 200: Health } } }, async () => {
    await db.execute('SELECT 1');
    return { status: 'ok' as const };
  });

  await app.register(
    async (instance) => {
      const api = instance.withTypeProvider<TypeBoxTypeProvider>();
      // ---- Workers ---------------------------------------------------------
      api.post(
        '/workers/register',
        {
          schema: { body: RegisterWorkerRequest, response: { 201: RegisterWorkerResponse } },
          config: config.rateLimit
            ? { rateLimit: { max: config.rateLimit.registerMaxPerHour, timeWindow: '1 hour' } }
            : {},
        },
        async (request, reply) => {
          const registered = await registerWorker(db, request.body, config);
          request.log.info({ worker_id: registered.worker_id }, 'worker registered');
          return reply.status(201).send(registered);
        },
      );

      api.post(
        '/workers/heartbeat',
        {
          schema: { body: HeartbeatRequest, response: { 200: HeartbeatResponse } },
          preHandler: authWorker,
        },
        async (request) => ({ server_time: await recordHeartbeat(db, request.body) }),
      );

      api.post(
        '/workers/capabilities',
        { schema: { body: UpdateCapabilitiesRequest }, preHandler: authWorker },
        async (request, reply) => {
          await updateCapabilities(db, request.body.worker_id, request.body.capabilities);
          return reply.status(204).send();
        },
      );

      api.get(
        '/workers/:id/stats',
        { schema: { params: WorkerParams, response: { 200: WorkerStats } } },
        async (request) => workerStats(db, request.params.id),
      );

      // ---- Tasks -----------------------------------------------------------
      api.post(
        '/tasks/lease',
        {
          schema: { body: LeaseRequest, response: { 200: LeaseResponse } },
          preHandler: authWorker,
        },
        async (request) => {
          await touchWorker(db, request.body.worker_id);
          const leased = await withDeadlockRetry(() => leaseTask(db, request.body, config));
          if (leased.task) {
            request.log.info(
              {
                task_id: leased.task.id,
                worker_id: request.body.worker_id,
                project_id: leased.task.project_id,
              },
              'task leased',
            );
          }
          return leased;
        },
      );

      api.post(
        '/tasks/:id/extend',
        {
          schema: {
            params: TaskParams,
            body: ExtendLeaseRequest,
            response: { 200: ExtendLeaseResponse },
          },
          preHandler: authWorker,
        },
        async (request) =>
          extendLease(db, request.params.id, request.body.worker_id, request.body.lease_id, config),
      );

      const resultRoute = {
        schema: {
          params: TaskParams,
          body: ResultSubmission,
          response: { 200: ResultSubmissionResponse },
        },
        preHandler: authWorker,
      };
      const resultHandler = async (
        request: FastifyRequest<{ Params: { id: string }; Body: ResultSubmission }>,
      ) => {
        const { body } = request;
        const outcome = await withDeadlockRetry(() => submitResult(db, request.params.id, body));
        request.log.info(
          {
            task_id: request.params.id,
            worker_id: body.worker_id,
            provider: body.provider,
            model: body.model,
            duration_ms: body.metrics.duration_ms,
            outcome: outcome.response.status,
            task_status: outcome.taskStatus,
          },
          'result submitted',
        );
        return outcome.response;
      };
      // §32 names the route `/result`, §24 `/results`; accept both.
      api.post('/tasks/:id/result', resultRoute, resultHandler);
      api.post('/tasks/:id/results', resultRoute, resultHandler);

      api.post(
        '/tasks/:id/fail',
        {
          schema: { params: TaskParams, body: TaskFailRequest, response: { 200: FailResponse } },
          preHandler: authWorker,
        },
        async (request) => {
          const status = await failTask(db, request.params.id, request.body, config);
          request.log.info(
            {
              task_id: request.params.id,
              worker_id: request.body.worker_id,
              reason: request.body.reason,
              retry_count: request.body.attempts,
              task_status: status,
            },
            'task failed',
          );
          return { task_status: status };
        },
      );

      // ---- Projects --------------------------------------------------------
      api.get('/projects', { schema: { response: { 200: ProjectList } } }, async () => ({
        projects: await listProjects(db),
      }));

      api.get(
        '/projects/:id',
        { schema: { params: ProjectParams, response: { 200: Project } } },
        async (request) => toProject(await getProjectRow(db, request.params.id)),
      );

      api.post(
        '/projects',
        { schema: { body: ProjectDefinition, response: { 201: Project } }, preHandler: authAdmin },
        async (request, reply) => reply.status(201).send(await createProject(db, request.body)),
      );

      api.post(
        '/projects/:id/tasks',
        {
          schema: {
            params: ProjectParams,
            body: CreateTasksRequest,
            response: { 201: CreateTasksResponse },
          },
          preHandler: authAdmin,
        },
        async (request, reply) =>
          reply.status(201).send(await ingestTasks(db, request.params.id, request.body)),
      );

      api.get(
        '/projects/:id/stats',
        {
          schema: { params: ProjectParams, response: { 200: ProjectStats } },
          preHandler: authAdmin,
        },
        async (request) => projectStats(db, request.params.id),
      );

      // ---- Observability ---------------------------------------------------
      api.get('/metrics', { schema: { response: { 200: Metrics } } }, async () =>
        collectMetrics(db, config.heartbeatIntervalMs),
      );

      api.get('/network', { schema: { response: { 200: NetworkSummary } } }, async () =>
        networkSummary(db, config.heartbeatIntervalMs),
      );
    },
    { prefix: API_PREFIX },
  );

  return app;
}
