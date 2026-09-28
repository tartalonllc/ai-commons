# Protocol

All wire types live in `@ai-commons/protocol` as TypeBox schemas. Each schema
is plain JSON Schema at runtime and a TypeScript type at compile time, so the
coordinator, worker, and stored project schemas share one definition.

- Protocol version: `0.1.0` (`PROTOCOL_VERSION`)
- API prefix: `/api/v1`
- Request objects set `additionalProperties: false`; unknown fields are rejected.
- Validate untrusted input with `parse(schema, input)`.

## Design decisions

**Coordinator-assigned worker IDs.** `POST /workers/register` returns
`worker_id` and a one-time `worker_secret` (the coordinator stores only a hash).
Server-issued random IDs cannot be squatted and reveal nothing about the machine.

**Prompts are declarative templates.** A project's `prompt` holds `system` and
`user` strings with `{{field}}` placeholders that the worker fills from the task
payload using `renderPrompt`. No project code runs on workers, and volunteers can
inspect exactly what is sent to their provider. Substitution is single-pass, so
payload text containing `{{...}}` is never re-expanded.

**Leases carry `project_version`,** so a worker can tell when its cached project
definition is stale and refetch `GET /projects/:id`.

**`local_models_only`** is part of project requirements. Workers declare
`local_inference` when leasing; the coordinator must not hand such tasks to
workers that can only use remote providers.

**Contribution accounting** reports local inference time and paid API cost
separately. AI Compute Units are derived only from real API cost
(`ACU = cost_usd / 0.001`).

## Limits

| Limit                 | Value      |
| --------------------- | ---------- |
| Task payload          | 1 MB       |
| Result                | 32 KB      |
| Task runtime          | 10 minutes |
| Lease duration        | 15 minutes |
| Heartbeat interval    | 60 seconds |
| Tasks per ingest call | 1,000      |

Byte-size limits cannot be expressed in JSON Schema; enforce them with
`jsonByteLength()` on both coordinator and worker.

## Task lifecycle

`PENDING → LEASED → COMPLETED | FAILED | CANCELLED`. An expired lease returns
the task to `PENDING`. Results are idempotent on `task_id + worker_id`.
