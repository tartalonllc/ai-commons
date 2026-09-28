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
shell history and process listings).

## Files

| What         | Windows                            | macOS                                      | Linux                         |
| ------------ | ---------------------------------- | ------------------------------------------ | ----------------------------- |
| Config       | `%APPDATA%\ai-commons\config.json` | `~/Library/Application Support/ai-commons` | `$XDG_CONFIG_HOME/ai-commons` |
| Database/log | `%LOCALAPPDATA%\ai-commons\`       | same as config                             | `$XDG_DATA_HOME/ai-commons`   |

`AICOMMONS_CONFIG_DIR` / `AICOMMONS_DATA_DIR` override these. The config file
holds no secrets; its schema rejects unknown fields.

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
- If a paid provider does not report actual cost, or fails in a way that may
  have been billed (timeout, invalid output, unknown), the full reservation is
  charged. Only pre-billing errors (auth, bad request, rate limit, unavailable,
  missing model) release it.
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
  if (!apiKey) throw new Error('No API key stored; run "aicommons set-key openai"');
  return new OpenAIProvider({ apiKey, pricing: cfg.pricing });
},
```

## Not yet implemented

- Idle-only scheduling (config accepts `idle_only`, `start` refuses it).
- CPU/GPU percentage limits are recorded but advisory.
- One task at a time per worker process.
