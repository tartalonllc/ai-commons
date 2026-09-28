# Architecture

AI Commons coordinates volunteer AI inference for public-good workloads. The MVP
deliberately stays boring: HTTP + JSON, PostgreSQL on the coordinator, SQLite on
workers, typed schemas, and provider adapters.

## Components

```text
Project owner ──(project-sdk)──► Coordinator ◄──── Dashboard
                                  │   │
                          PostgreSQL  │  HTTPS /api/v1 (poll)
                                      ▼
                    Worker A     Worker B     Worker C
                    (SQLite)     (SQLite)     (SQLite)
                       │            │            │
                    Ollama       OpenAI*       Ollama
                                (*key stays local)
```

| Package / app             | Role                                                                     |
| ------------------------- | ------------------------------------------------------------------------ |
| `packages/protocol`       | Wire schemas (TypeBox = JSON Schema + TS types), limits, prompt renderer |
| `packages/validators`     | Output-schema checks, project-schema linting, consensus, result hashes   |
| `packages/providers/core` | `AIProvider` interface and `ProviderError`                               |
| `packages/providers/*`    | Adapters (Ollama, one commercial provider)                               |
| `packages/project-sdk`    | `defineProject`, admin client, JSONL ingestion                           |
| `apps/coordinator`        | Fastify API, task queue, leasing, validation, accounting                 |
| `apps/worker`             | CLI worker: execution pipeline, local limits, budget, credentials        |
| `apps/dashboard`          | Network, project, and contribution views                                 |
| `examples/*`              | Example workloads                                                        |

## Data flow

1. **Define.** A project owner validates a project with `defineProject` and
   creates it with `POST /projects`, then ingests tasks with
   `POST /projects/:id/tasks`.
2. **Register.** A worker calls `POST /workers/register` with its capabilities
   and receives a random `worker_id` and a one-time `worker_secret`.
3. **Lease.** The worker polls `POST /tasks/lease`. The coordinator issues a
   15-minute lease inside a transaction, matching capabilities, categories,
   and `local_models_only`. It never gives the same worker two replicas of one
   task.
4. **Execute.** The worker fetches and caches the project definition, picks a
   compatible provider, checks local limits and budget, renders the prompt
   template, runs inference, and validates the output against the project's
   output schema.
5. **Submit.** `POST /tasks/:id/result` is idempotent on `task_id + worker_id`.
   After retries (5 s, then 30 s), the worker calls `POST /tasks/:id/fail`
   instead.
6. **Validate and account.** The coordinator re-checks the output schema,
   applies consensus, and credits contributions.

## Trust boundaries

Every party is treated as potentially untrusted (spec §41).

- **Coordinator → worker.** Tasks are data plus AI requests only. Workers run
  no project code. Prompts are `{{field}}` templates visible to the volunteer.
  Workers enforce their own payload, runtime, and output limits.
- **Worker → coordinator.** Results may be wrong or fraudulent. They are
  schema-checked, size-limited, hashed, and accepted only through consensus
  when replication is configured. Workers authenticate with bearer secrets,
  and the coordinator stores only a hash of each secret.
- **Provider credentials** never leave the worker. They live in the OS
  credential store (Credential Manager/DPAPI, Keychain, Secret Service), never
  in plaintext and never in logs.
- **Spending limits** are enforced by the worker's local SQLite ledger before
  each paid request. The coordinator is never trusted to enforce them.
- **Project schemas** come from project owners and are interpreted, never
  compiled to code. `$ref` and unknown keywords are rejected at definition
  time.

## Task lifecycle

```text
PENDING ──lease──► LEASED ──result──► COMPLETED (once consensus reached)
   ▲                  │
   └──lease expiry────┤
   └──fail (retryable)┘──► FAILED (retry limit)      CANCELLED (owner)
```

With `replication_factor = N`, a task stays leasable until N distinct workers
have submitted. On disagreement, one more replica is requested, up to 5.

## Validation

Validation is deterministic. The MVP uses no LLM judging.

1. **Schema:** the result must satisfy the project's output JSON Schema and be
   at most 32 KB.
2. **Consensus:** results are compared on `consensus_fields`, with strings
   compared case- and whitespace-insensitively and arrays order-insensitively.
   A strict majority of the required replicas wins.
3. **Reference tasks** (known-answer tasks) are planned after the MVP.

## Contribution accounting

The coordinator credits tasks completed, tasks validated, input and output
tokens, local inference time, total execution time, and API cost. AI Compute
Units are derived only from real API cost (`ACU = cost_usd / 0.001`). Local
inference is reported as raw time until a defensible normalization exists.
Public statistics expose only random worker IDs.
