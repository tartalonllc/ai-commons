# Coordinator

`apps/coordinator` is a Fastify 5 service backed by PostgreSQL (Drizzle ORM).
It registers workers, ingests project tasks, leases them, validates results, and
tracks contributions. It never receives provider API keys: workers call their
providers locally and submit only structured results.

## Running

```sh
docker compose up -d                 # postgres:17 on localhost:55432 (+ aicommons_test db)
pnpm --filter @ai-commons/coordinator build
cd apps/coordinator
DATABASE_URL=postgres://aicommons:aicommons@localhost:55432/aicommons \
ADMIN_TOKEN=<at least 24 chars> node dist/index.js
```

Migrations run automatically at startup (or `pnpm db:migrate`). After editing
`src/db/schema.ts`, run `pnpm db:generate` and commit the new file in `drizzle/`.

| Env var                        | Default        | Notes                                  |
| ------------------------------ | -------------- | -------------------------------------- |
| `DATABASE_URL`                 | —              | required, `postgres://`                |
| `ADMIN_TOKEN`                  | —              | required, ≥ 24 chars; bearer for admin |
| `PORT` / `HOST`                | 8080 / 0.0.0.0 |                                        |
| `RATE_LIMIT_MAX`               | 300            | requests/minute per IP                 |
| `RATE_LIMIT_REGISTER_PER_HOUR` | 20             | registrations/hour per IP              |
| `RATE_LIMIT_DISABLED`          | —              | `true` disables (tests only)           |
| `LOG_LEVEL`                    | info           |                                        |
| `DASHBOARD_DIR`                | —              | serve a built dashboard at `/`         |

When `DASHBOARD_DIR` is set (e.g. `apps/dashboard/dist`), the coordinator serves
it with `@fastify/static`: no directory listing, dotfiles denied, hashed
`assets/*` cached immutably, `index.html` revalidated and sent with a strict
Content-Security-Policy. API routes are unaffected. Startup fails if the
directory has no `index.html`.

Tests need the compose database running: `pnpm --filter @ai-commons/coordinator test`
(override with `TEST_DATABASE_URL`). The test setup drops and recreates the
schema of the test database.

## API (`/api/v1`)

| Method | Path                                  | Auth   | Body / Response                                        |
| ------ | ------------------------------------- | ------ | ------------------------------------------------------ |
| POST   | `/workers/register`                   | none   | `RegisterWorkerRequest` → 201 `RegisterWorkerResponse` |
| POST   | `/workers/heartbeat`                  | worker | `HeartbeatRequest` → `HeartbeatResponse`               |
| POST   | `/workers/capabilities`               | worker | `UpdateCapabilitiesRequest` → 204                      |
| GET    | `/workers/:id/stats`                  | none   | `WorkerStats`                                          |
| POST   | `/tasks/lease`                        | worker | `LeaseRequest` → `LeaseResponse`                       |
| POST   | `/tasks/:id/extend`                   | worker | `ExtendLeaseRequest` → `ExtendLeaseResponse`           |
| POST   | `/tasks/:id/result` (also `/results`) | worker | `ResultSubmission` → `ResultSubmissionResponse`        |
| POST   | `/tasks/:id/fail`                     | worker | `TaskFailRequest` → `{ task_status }`                  |
| GET    | `/projects`                           | none   | `ProjectList` (non-archived)                           |
| GET    | `/projects/:id`                       | none   | `Project` (includes prompt + schemas, §44)             |
| POST   | `/projects`                           | admin  | `ProjectDefinition` → 201 `Project`, 409 if id exists  |
| POST   | `/projects/:id/tasks`                 | admin  | `CreateTasksRequest` → 201 `CreateTasksResponse`       |
| GET    | `/projects/:id/stats`                 | admin  | `ProjectStats`                                         |
| GET    | `/metrics`                            | none   | §46 metrics (JSON)                                     |
| GET    | `/network`                            | none   | dashboard summary (§37)                                |
| GET    | `/healthz` (no prefix)                | none   | `{ status: "ok" }`                                     |

Errors always use the protocol `ApiError` shape (`{ error: { code, message } }`).

### Authentication

- **Workers:** `Authorization: Bearer <worker_secret>`. The worker is identified
  by `worker_id` in the (schema-validated) request body; the coordinator compares
  SHA-256 hashes in constant time. Only the hash is stored. Unknown worker and
  wrong secret return the same 401.
- **Admin:** `Authorization: Bearer <ADMIN_TOKEN>`, constant-time compare.

## Leasing

Leasing runs in one transaction:

1. Expired active leases are marked `expired` and their capacity is returned
   (lazy reclaim; no background job).
2. The next eligible task is selected `FOR UPDATE OF t SKIP LOCKED`, ordered by
   priority then age. Eligibility: project `active`, category filter,
   `local_models_only` only for workers declaring `local_inference`,
   `minimum_context_window ≤ max_context_window`, and the worker has never held a
   lease on this task (also enforced by a unique index on `(task_id, worker_id)`).
3. Capacity uses counters stored on the task row
   (`active_leases + completed_replicas < replication_factor`). Because the
   leasing transaction updates that row, Postgres re-checks the predicate against
   the fresh row version if two requests race, so a task is never over-assigned.

Under contention `SKIP LOCKED` can return no task even though capacity exists
(the row was momentarily locked); the worker just polls again after
`retry_after_ms`.

Task status: `PENDING` (no active leases), `LEASED` (≥ 1 active lease),
`COMPLETED`, `FAILED`, `CANCELLED` (terminal).

## Result validation

1. The lease must exist, belong to the caller and the task (`403`/`404`), and be
   active and unexpired (`409 lease_expired`).
2. A second submission from the same worker for the same task returns
   `status: "duplicate"` with no additional credit (§51).
3. The result must pass `checkOutput` (project `output_schema`, ≤ 32 KB). If not,
   the response is `status: "rejected"`, the lease ends, and the replica slot
   returns to the pool.
4. Accepted results are stored with `result_hash` (`validators.resultHash`), and
   the worker is credited `tasks_completed`, tokens, and execution time.
   Execution time counts as local inference time when the submitting provider was
   advertised as `kind: "local"`; `cost_usd` is credited only for remote providers.
5. Validation by project mode:
   - `schema` (and `deterministic`, not yet specialised): the first valid result
     completes the task.
   - `consensus`: `evaluateConsensus` over `consensus_fields`. On agreement the
     task completes and every agreeing worker gets `tasks_validated`; on
     disagreement the task's `replication_factor` grows by one (tie-breaker); at
     the replica cap (5) without majority the task is `FAILED`. Late replicas
     that match the accepted consensus key are credited as validated.

`POST /tasks/:id/fail` ends the lease and returns the task to the queue; after
three failures (across workers) the task becomes `FAILED`.

AI Compute Units are derived only from donated API cost: `ACU = api_cost_usd / 0.001`.

## Project creation checks

- `input_schema` / `output_schema` pass `checkProjectSchema` (no `$ref`, known
  keywords only, bounded depth).
- Every prompt `{{placeholder}}` is a property of `input_schema`.
- Consensus projects need `replication_factor ≥ 2` and non-empty
  `consensus_fields`, each a property of `output_schema`.
- Task ingestion is all-or-nothing: each payload is checked against
  `input_schema` and the 1 MB limit; duplicate ids reject the whole batch (409).

## Privacy and logging

`/network` exposes only random worker IDs, status, task counts, and last-seen
time: no IPs, platforms, providers, or models (§52). Logs are structured (Pino);
`authorization` headers and secrets are redacted, and request bodies/task
payloads are never logged.
