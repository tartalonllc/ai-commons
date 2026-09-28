# Progress Report

_Last updated: 2026-09-28 · HEAD `2167c38` on `main` · no remote configured yet_

The build follows the spec in [`Open Compute.md`](./Open%20Compute.md). Steps 1–19 of
the §68 build order are **done**. Only step 20 (packaging the Windows worker) is left.
See [NEXT_STEPS.md](./NEXT_STEPS.md) to continue.

## Status at a glance

| §68 step | Item                                                          | Status                                                        |
| -------- | ------------------------------------------------------------- | ------------------------------------------------------------- |
| 1–5      | Monorepo, protocol, Project/Task/Result schemas               | ✅                                                            |
| 6–10     | Postgres schema; register / ingest / lease / result endpoints | ✅                                                            |
| 11       | CLI worker                                                    | ✅                                                            |
| 12       | Ollama adapter                                                | ✅ verified against real Ollama (`qwen3:4b`)                  |
| 13       | Abstract-classification demo                                  | ✅ 20 real arXiv abstracts committed; fetch script for 10k    |
| 14       | Two+ workers simultaneously                                   | ✅ 3 real workers, 20/20 tasks                                |
| 15       | Result validation (schema + consensus)                        | ✅                                                            |
| 16       | Contribution metrics                                          | ✅                                                            |
| 17       | Commercial provider adapter (OpenAI)                          | ✅ tested against a mocked network only, no live API call yet |
| 18       | Local budget limiter                                          | ✅                                                            |
| 19       | Dashboard                                                     | ✅ checked in a real browser (desktop, 390px, dark mode)      |
| 20       | Package Windows worker (Tauri)                                | ⏳ not started                                                |

The spec's phase success conditions (§58): Phases 1–7 are met. Phase 6's "worker cannot
exceed spending ceiling" is covered by randomized tests but hasn't been exercised against
the live OpenAI API. The §59 MVP acceptance test (10 machines, 10,000 tasks, 2 providers)
has **not** been run yet.

## Verification snapshot

- `pnpm format:check`, `pnpm lint`, `pnpm build`, `pnpm typecheck`: all clean.
- `pnpm test`: **277 tests pass**. By package: protocol 23, validators 22, provider-core 22,
  provider-ollama 25, provider-openai 36, project-sdk 10, example 6, coordinator 51,
  worker 58, dashboard 29.
  - Coordinator tests need Docker Postgres on port 55432 (`docker compose up -d`).
- CI (`.github/workflows/ci.yml`) is written but **has never run**, because there's no GitHub remote yet.

### End-to-end runs performed

1. **Fake Ollama, 2 workers.** 20/20 tasks, replication factor 2, 40 inferences, and every result agreed.
2. **Real Ollama `qwen3:4b`, 3 workers.** 20/20 accepted and 0 failed.
   - 43 inferences: 17 tasks were settled by two agreeing replicas, and 3 needed a 2–1 tie-breaker.
   - Median 4.1 s per inference, max 7.6 s. No retries, and no schema failures.
   - Disagreements: fMRI paper (medicine vs biology), galaxy outflows (computational vs
     observational), quantum channel capacity (computational vs theoretical).

## What exists

| Path                               | Package                            | Summary                                                                                                               |
| ---------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `packages/protocol`                | `@ai-commons/protocol`             | TypeBox wire schemas, `parse()`, `renderPrompt()`, limits, observability schemas                                      |
| `packages/validators`              | `@ai-commons/validators`           | `checkInput`/`checkOutput`/`checkAgainstSchema`, `checkProjectDefinition`, consensus, result hash                     |
| `packages/providers/core`          | `@ai-commons/provider-core`        | `AIProvider` interface, `ProviderError` (with `billed`), shared HTTP helper                                           |
| `packages/providers/ollama`        | `@ai-commons/provider-ollama`      | `/api/chat` with structured `format`, `think:false`, token metrics                                                    |
| `packages/providers/openai`        | `@ai-commons/provider-openai`      | Chat Completions with `json_schema`; refuses unpriced models; key only in the auth header                             |
| `packages/project-sdk`             | `@ai-commons/project-sdk`          | `defineProject`, `CoordinatorAdminClient`, `readJsonl`                                                                |
| `apps/coordinator`                 | `@ai-commons/coordinator`          | Fastify + Drizzle/Postgres, leasing with `SKIP LOCKED`, consensus, rate limits, `/network`, `/metrics`                |
| `apps/worker`                      | `@ai-commons/worker` (`aicommons`) | CLI worker with SQLite accounting, budget reservations, OS keyring secrets, retries 5s/30s                            |
| `apps/dashboard`                   | `@ai-commons/dashboard`            | Vanilla TS + Vite; live overview and a public page per project; served by the coordinator when `DASHBOARD_DIR` is set |
| `examples/abstract-classification` | example                            | Demo project, `fetch-arxiv.ts`, `publish.ts`, `data/sample.jsonl` (20 records)                                        |
| `docs/`                            |                                    | architecture, protocol, coordinator, worker, providers, security, project-sdk, dashboard                              |

## Key decisions (and why)

- **Prompts are declarative `{{field}}` templates, not code.** §42 forbids running project
  code on workers, and §44 requires prompts to be visible to volunteers. Substitution is
  single-pass, so payload text can't inject further placeholders.
- **The coordinator assigns worker IDs** (§49 over §12). Random server-issued IDs can't be
  squatted, and they reveal nothing about the machine (§52). The coordinator stores only a
  SHA-256 hash of each worker secret.
- **TypeBox instead of Zod.** One definition gives the TS types, Fastify validation and the
  stored JSON Schema. Untrusted project schemas are _interpreted_, never compiled to code,
  and `$ref` and unknown keywords are rejected.
- **TypeScript is pinned to `~6.0.3`**, because typescript-eslint doesn't support TS 7 yet.
- **Consensus rule:** a strict majority of max(replication factor, number of results) must
  agree on the `consensus_fields`. On disagreement, one more replica is requested, up to 5
  (unresolved means `FAILED`). There's no LLM judging (§23).
- **Budget accounting:**
  - The worker reserves the estimated **maximum** cost in SQLite before each remote call,
    then settles to the actual cost afterwards.
  - Only `ProviderError.billed === false` frees a reservation; unknown or billed failures
    are charged in full.
  - Reservations stranded by a crash count as spent.
  - OpenAI refuses to run any model without a configured price.
- **Secrets** live only in the OS keyring (`@napi-rs/keyring`). If the keyring is
  unavailable the worker refuses to start; it never falls back to plaintext. The service
  name is `ai-commons`.
- **ACUs** (AI Compute Units) come only from real API cost (`cost / $0.001`). Local
  inference is reported as raw time and tokens (§26).
- **Defaults are safe:** a new worker config sets the API budget to `$0/day`, `$0/month`.

## Known gaps / tech debt

These came from the agents' reports and are tracked in NEXT_STEPS.md.

- **Coordinator:**
  - Rate limits are per-IP only.
  - `deterministic` validation mode behaves like `schema`.
  - There are no project update, pause or archive endpoints.
  - An empty lease under lock contention returns a 30s `retry_after_ms`, which is too
    conservative.
  - There are no CORS headers.
  - The `/network` workers list is capped at 100.
- **Worker:**
  - `idle_only` scheduling isn't implemented, so `start` refuses to run in that mode.
  - CPU and GPU percentage limits are recorded but not enforced.
  - It runs one task at a time.
  - Nothing prevents two `start` processes from running at once; the budget stays safe
    because reservations are transactional.
  - There's no `--endpoint` flag for `configure`, so a custom Ollama URL has to be edited
    into the config JSON.
  - The `context_window` of a configured model isn't auto-filled from `getModels()`.
- **Providers:**
  - `estimateTokens` assumes about 4 characters per token, which undercounts some
    languages. OpenAI compensates with a 1.5× safety factor.
  - OpenAI has never been called live.
- **Validation:** a task whose two replicas disagree waits for a _third distinct_ worker.
  With only two volunteers online it stalls, and the dashboard doesn't show that state.
- **Dashboard:**
  - There's no per-project "goal" field, so the description is used instead.
  - About 43 KB gzipped, mostly the TypeBox validator.
- **Repo hygiene:** `CONTRIBUTING.md`, `SECURITY.md` and `CODE_OF_CONDUCT.md` (§55) are
  missing, and the README doesn't yet answer all ten §56 questions.

## Local environment notes (this machine)

- Windows 11, Node 24.16, pnpm 10.34.5, Docker Desktop.
- Postgres runs in Docker container `aicommons-postgres` on host port **55432**
  (user/password `aicommons`).
  - Databases: `aicommons` (dev), `aicommons_test` (tests), plus scratch databases
    `aicommons_e2e`, `aicommons_real` and `aicommons_dash_test`, which are safe to drop.
- Ollama 0.34.4 is installed at `%LOCALAPPDATA%\Programs\Ollama\ollama.exe`. It's **not on
  PATH**; its server runs on `:11434`. `qwen3:4b` is pulled and probably runs on the CPU
  (the GPU is an AMD RX 5700 XT).
- Test worker secrets written during e2e runs were removed from Windows Credential Manager.
