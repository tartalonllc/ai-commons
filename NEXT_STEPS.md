# Next Steps

_Pick up here. Current state: [PROGRESS.md](./PROGRESS.md). Spec: [`Open Compute.md`](./Open%20Compute.md)._

## Resume checklist (about 2 minutes)

```sh
docker compose up -d        # Postgres on :55432 (container aicommons-postgres)
pnpm install
pnpm build
pnpm test                   # expect 452 passing
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

## Current work: MVP acceptance scale-up

The Windows desktop worker (§68 step 20, §35–§36) is done — see
[`docs/desktop.md`](./docs/desktop.md) and the e2e results in PROGRESS.md. The user selected B.
A bounded single-machine mixed-provider run is complete; the full 10-machine acceptance test remains.
The user authorized publishing to the public `ai-commons` GitHub repository on 2026-10-11.

### B. MVP acceptance scale-up (§59–§60)

1. **Fetched 9,987 unique abstracts** to `data/abstracts.jsonl`; arXiv rate-limited the final
   top-off. The fetcher now resumes and honors `Retry-After`; fetch the remaining 13 to reach 10,000.
2. **Done:** published 9,987 tasks to the local coordinator.
3. **Done:** added the commercial provider and completed 101 live calls within the local budget caps:
   - `aicommons set-key openai`
   - Add `pricing` for one cheap model to the worker config (USD per 1M input and output tokens).
   - Set `--daily-usd 0.25 --monthly-usd 5`.
   - First live call verified token and cost accounting: 741 input / 56 output tokens and
     USD 0.000386; OpenAI Usage dashboard now shows the usage.
   - Anthropic Messages API, keyring setup, desktop Settings controls, pricing config, and tests are implemented.
     The key is stored; the bounded live check received HTTP 400 during the model availability
     preflight, before sending an inference request. Confirm API key/workspace access before retrying.
4. **Partial:** two local workers and one OpenAI worker completed 127 tasks on one machine,
   with zero task failures; coordinator cost was USD 0.0402844 and the worker ledger showed USD 0.0414 (including a conservative unknown-billed charge). Repeat across more machines and continue
   toward 10,000 tasks; verify credential isolation in coordinator logs and the database.
5. The user does not yet have 10 machines. Continue with a low-volume, mixed-provider validation
   on the available PC; do not run the full dataset against both Ollama workers while CPU/GPU
   limits remain advisory. Revisit the 10-machine acceptance test when more workers are available.

### C. Publish to GitHub

- **Done:** user confirmed the public target `tartalonllc/ai-commons`; `origin` points to it.
- Add the missing §55 files: `CONTRIBUTING.md`, `SECURITY.md` (with a vulnerability
  reporting contact), and `CODE_OF_CONDUCT.md`.
- **Done:** rewrote the README to answer the ten §56 questions.
- Enable Issues and Discussions (§55).
- Check the CI result after this push. There is no Windows CI job yet; see the desktop
  follow-ups below.

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
- Commits end with a `Co-Authored-By` line. The public GitHub remote is now configured.
- The user OK'd parallel subagents. Each works in its own git worktree against the shared
  contracts (protocol, provider-core, validators), and the main session merges and
  regenerates `pnpm-lock.yaml` on conflict.
- `turbo.json` has `"agentGuidance": false`, so turbo won't rewrite `AGENTS.md`.
