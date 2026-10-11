# Worker

`apps/worker` is the volunteer CLI (`aicommons`). It leases tasks from a
coordinator, runs them through a local or remote AI provider, validates the
output, and submits results, while enforcing the volunteer's limits locally.

## Commands

| Command                           | Purpose                                                           |
| --------------------------------- | ----------------------------------------------------------------- |
| `aicommons configure`             | Interactive setup, or non-interactive with flags (see `help`)     |
| `aicommons status`                | Registration, mode, today's contribution, providers, limits       |
| `aicommons start [--max-tasks N]` | Contribute. Ctrl+C once: finish current task; twice: cancel it    |
| `aicommons pause` / `resume`      | Persisted; a running worker picks it up on its next poll          |
| `aicommons set-key <provider>`    | Store an API key in the OS credential store (hidden prompt/stdin) |
| `aicommons usage`                 | API spend vs. limits, contribution totals (today/month/all time)  |
| `aicommons inspect <project>`     | Description, prompt template, output schema, requirements (§44)   |

API keys are never accepted as command-line arguments (they would end up in
shell history and process listings). `start` refuses to run while another
worker holds `worker.lock` in the data dir (see "Single-instance lock"
below).

## Files

| What         | Windows                            | macOS                                      | Linux                         |
| ------------ | ---------------------------------- | ------------------------------------------ | ----------------------------- |
| Config       | `%APPDATA%\ai-commons\config.json` | `~/Library/Application Support/ai-commons` | `$XDG_CONFIG_HOME/ai-commons` |
| Database/log | `%LOCALAPPDATA%\ai-commons\`       | same as config                             | `$XDG_DATA_HOME/ai-commons`   |

`AICOMMONS_CONFIG_DIR` / `AICOMMONS_DATA_DIR` override these. The config file
holds no secrets; its schema rejects unknown fields.

## Single-instance lock

`src/lock.ts` writes an exclusive `worker.lock` (containing the PID) into the
data dir, acquired by both `aicommons start` and the desktop daemon. It's
created atomically: the PID is written to a temp file, then that file is
hard-linked into place, so the lock never exists without its PID already in
it. A lock is reclaimed when its PID is no longer running, its content isn't
a readable PID, or its mtime predates the current boot (which means any PID
it names has since been recycled). Budget safety never depends on this lock
— reservations are transactional — it only prevents double contribution and
duplicate heartbeats.

Two caveats: hard links fail on FAT32/exFAT and on some network drives, so
pointing `AICOMMONS_DATA_DIR` at one of those breaks startup. A large clock
correction right after boot can also make a live lock look like it predates
boot and get reclaimed from under a running process.

## Desktop daemon

The Windows desktop app (`docs/desktop.md`) runs this same worker as a
supervised child process — a "daemon" speaking newline-delimited JSON over
stdio — instead of the CLI's `start` loop. `apps/worker/src/daemon/*` holds
the wire protocol and the `WorkerDaemon` request loop; `pnpm --filter
@ai-commons/worker bundle:daemon` produces the esbuild bundle
(`dist-daemon/worker-daemon.mjs`) that the desktop app stages into its
runtime resources.

## Execution pipeline

1. Lease (`POST /tasks/lease`) with capabilities and category preferences.
2. Load the project definition, cached by `project_version`.
3. Validate: project active, project schemas pass `checkProjectSchema`
   (no `$ref`, bounded depth), payload ≤ 1 MB and matches `input_schema`.
4. Render the declarative prompt template (`renderPrompt`).
5. Select a provider: local first; remote only if the task is not
   `local_models_only`, the volunteer allowed remote use for this project
   (`projects.allow_remote_for_projects`), and the API limit is non-zero.
6. For remote providers: `estimateCost` → reserve against the budget. No
   estimate, no call.
7. Execute with a deadline of the remaining 10-minute task budget.
8. Validate output against `output_schema` (`checkOutput`).
9. Submit (`POST /tasks/:id/result`), retrying transient coordinator errors.

Retries follow §47: up to 3 attempts with 5 s and 30 s delays, only for
retryable `ProviderError`s (unavailable, timeout, rate-limited, invalid output).
Non-retryable errors (auth, bad request, missing model) move to the next
candidate provider. After the final failure the worker calls
`POST /tasks/:id/fail` with a scrubbed message.

Leases are extended every `lease_duration / 3`. If the coordinator reports the
lease as expired, the task is abandoned without submission. Heartbeats run every
`heartbeat_interval_ms`.

## Budget enforcement

`BudgetLimiter` (`src/budget.ts`) is the only path to a paid API call.

- Costs are stored as integer micro-USD and always rounded up.
- `reserve()` runs in a `BEGIN IMMEDIATE` SQLite transaction and checks both the
  UTC-day and UTC-month windows. It is safe across multiple worker processes
  sharing the database.
- Reserved and orphaned rows count at their reserved amount; settled rows at
  actual cost.
- If a paid provider does not report actual cost, the full reservation is
  charged. A failed call is settled by its `ProviderError.billed` verdict (see
  `docs/providers.md`): only `billed: false` releases the reservation;
  `billed: true` and unknown (`undefined`) are charged in full.
- Reservations older than the task runtime limit + 1 minute (crash leftovers)
  are finalized as spent.
- Actual cost higher than the estimate is recorded truthfully and blocks every
  later reservation in that window. The worst-case overshoot is bounded by the
  estimate error of calls already in flight.

## Wiring provider adapters

Adapters implement `AIProvider` from `@ai-commons/provider-core` and are
registered in `src/providers/builtin.ts` by replacing the `notWired` factories:

```ts
factory: async (cfg) => new OllamaProvider({ baseUrl: cfg.endpoint ?? 'http://localhost:11434' }),
```

```ts
factory: async (cfg, secrets) => {
  const apiKey = await secrets.get(secretAccounts.provider(cfg.id));
  if (!apiKey) throw new Error(`No API key stored; run "aicommons set-key ${cfg.id}"`);
  return new OpenAIProvider({ apiKey, pricing: cfg.pricing });
},
```

## Provider endpoints must use TLS remotely

`validateConfig` (and `probeProvider` in the desktop daemon) reject a remote
provider endpoint that isn't `https://`, unless it points at this machine
(`localhost`, `127.0.0.1`, `::1`). A provider endpoint can carry an API key,
so sending it in cleartext to anything but the local machine is refused. An
existing config with a plain-`http://` remote endpoint now fails to load;
the desktop app surfaces why in its "last error" banner, and the CLI reports
it as a `ConfigError`. Edit the endpoint (or `configure` again) to fix it.

## Not yet implemented

- Idle-only scheduling requires the desktop app (the CLI has no idle source
  and refuses it).
- CPU/GPU percentage limits are recorded but advisory.
- One task at a time per worker process.
