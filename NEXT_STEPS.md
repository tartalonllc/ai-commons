# Next Steps

_Pick up here. Current state: [PROGRESS.md](./PROGRESS.md). Spec: [`Open Compute.md`](./Open%20Compute.md)._

## Resume checklist (about 2 minutes)

```sh
docker compose up -d        # Postgres on :55432 (container aicommons-postgres)
pnpm install
pnpm build
pnpm test                   # expect 430 passing
```

Run the full stack locally:

```sh
# 1. Coordinator + dashboard at http://localhost:8080
DATABASE_URL=postgres://aicommons:aicommons@localhost:55432/aicommons \
ADMIN_TOKEN=<24+ random chars> DASHBOARD_DIR=apps/dashboard/dist \
node apps/coordinator/dist/index.js

# 2. Publish the demo project (20 sample abstracts)
cd examples/abstract-classification
COORDINATOR_URL=http://localhost:8080 ADMIN_TOKEN=<same> node scripts/publish.ts data/sample.jsonl

# 3. Worker (use AICOMMONS_CONFIG_DIR / AICOMMONS_DATA_DIR to run several side by side)
node apps/worker/dist/cli.js configure --coordinator-url http://localhost:8080 \
  --enable ollama --models ollama=qwen3:4b --mode active --categories all
node apps/worker/dist/cli.js start
```

Notes:

- Ollama isn't on PATH. The binary is at `%LOCALAPPDATA%\Programs\Ollama\ollama.exe`.
- Edit the worker's `config.json` to set `context_window` (e.g. `40960`) for the model.
  The demo needs at least 8192, and `configure` doesn't fill it in yet.
- After throwaway e2e runs, delete the test `worker:<coordinator-url>:<worker_id>` entries
  (service `ai-commons`) from Windows Credential Manager.

## Open decision: what next?

The Windows desktop worker (§68 step 20, §35–§36) is done — see
[`docs/desktop.md`](./docs/desktop.md) and the e2e results in PROGRESS.md. The last
session ended by asking the user to choose between the two remaining options below.
**Ask before starting C**, since it makes the code public.

### B. MVP acceptance scale-up (§59–§60)

1. `cd examples/abstract-classification && node scripts/fetch-arxiv.ts` fetches the full
   10,000 abstracts into `data/abstracts.jsonl`. It takes about 10 minutes with polite 3s
   delays, and the file is gitignored.
2. Publish it to a coordinator.
3. Add a commercial provider:
   - `aicommons set-key openai`
   - Add `pricing` for one cheap model to the worker config (USD per 1M input and output tokens).
   - Set `--daily-usd 0.25 --monthly-usd 5`.
   - This is the **first live OpenAI call**; verify token and cost accounting against the
     OpenAI usage dashboard.
4. Run several workers (and more machines if possible) with a mix of Ollama and OpenAI.
   Confirm the §59 criteria: leasing, validation, budget enforcement, contribution
   accounting, and that no credentials pass through the coordinator (grep coordinator
   logs and the database).
5. Throughput at about 4 s per task on this CPU is roughly 900 tasks/hour for each Ollama
   instance. Plan multiple machines, or accept a long run.

### C. Publish to GitHub

- Confirm the repo name and org with the user (spec suggests `ai-commons`; hosted-service
  owner is Tartalon, §62).
- Add the missing §55 files: `CONTRIBUTING.md`, `SECURITY.md` (with a vulnerability
  reporting contact), and `CODE_OF_CONDUCT.md`.
- Rewrite the README to answer all ten §56 questions.
- Enable Issues and Discussions (§55).
- `git remote add origin …`, push `main`, then check that CI goes green on both the
  Linux and Windows jobs. **The workflow has never run.**

## Smaller follow-ups (any time, low risk)

- **Worker:**
  - Add a `configure --endpoint <provider>=<url>` flag.
- **Desktop app (Windows):**
  - Code signing for the installer (SmartScreen currently warns on first run).
  - A CI `windows-latest` job that runs `cargo test` and `cargo tauri build` (there is
    none yet; the desktop app has only been built and tested locally).
  - Auto-update.
  - Watch for a recurrence of the unreproduced idle-only observation from the 2026-09-30
    e2e run (one run stayed on "Waiting for idle" for several minutes; two follow-up
    attempts with debug logging on could not reproduce it). If it recurs, capture the
    daemon's debug log and the Rust idle poller's samples around the stuck period.
- **Coordinator:**
  - Return a short `retry_after_ms` when a lease comes back empty because of lock
    contention (vs an empty queue).
  - Implement real `deterministic` validation mode.
  - Add project pause, archive and version-bump endpoints.
  - Add per-worker rate limits after auth.
  - Make CORS configurable.
- **Consensus visibility:** show "awaiting tie-breaker" counts on the dashboard. Consider
  letting a project fall back to accepting when too few distinct workers are online.
- **Protocol:** add an optional `goal` field to projects for the §38 public page.
- **Providers:**
  - Replace the 4-characters-per-token estimate with a stricter upper bound.
  - Add an `InferenceResult.cost_is_estimate` flag.
- **Worker:** enforce the CPU and GPU limits, which are currently only recorded.
- **Ops:** add Prometheus/OpenTelemetry export (§46 says "eventually").

## Working conventions used so far

- Follow `AGENTS.md`, and run format, lint, typecheck and tests before each commit.
- Commits end with a `Co-Authored-By` line. There's no remote yet, so nothing has been pushed.
- The user OK'd parallel subagents. Each works in its own git worktree against the shared
  contracts (protocol, provider-core, validators), and the main session merges and
  regenerates `pnpm-lock.yaml` on conflict.
- `turbo.json` has `"agentGuidance": false`, so turbo won't rewrite `AGENTS.md`.
