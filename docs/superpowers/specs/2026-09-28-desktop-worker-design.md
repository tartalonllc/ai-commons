# Desktop Worker (Windows, Tauri) — Design

_Status: approved 2026-09-28 · Spec refs: §34–§36, §58 Phase 8, §68 step 20_

## Goal

Wrap the existing CLI worker in a Windows desktop app that a non-developer volunteer
can install and control: the §35 status screen, §36 settings, pause/resume, real
idle-only scheduling, and an unsigned NSIS installer. Code signing and a CI build job
are out of scope for this milestone.

## Decisions

- **Architecture:** Tauri v2 Rust shell + the existing Node worker running as a
  supervised child process ("daemon"), talking newline-delimited JSON over stdio.
  No listening ports. All stateful logic (config, keyring, SQLite, budget,
  `WorkerRunner`) stays in the one TypeScript implementation.
- **Runtime:** the installer bundles a pinned Node 24.x `node.exe`, a single
  esbuild-bundled `worker-daemon.mjs`, and the `@napi-rs/keyring` package with its
  native addon, all under Tauri `resources` (`runtime/`). Rust starts `node.exe`
  with `std::process::Command` (`CREATE_NO_WINDOW`), so neither `externalBin`
  naming nor the shell plugin is needed. Volunteers need nothing else installed.
- **Rejected:** a localhost HTTP/WebSocket daemon (opens a local attack surface);
  Rust reading SQLite/config directly or porting the worker to Rust (duplicates
  budget/keyring logic that could drift, violating "no spending limit can be
  bypassed").

## Components

```
apps/desktop/                 Tauri v2 app
  src-tauri/                  Rust: window, tray, idle detector, daemon supervisor,
                              stdio relay (emits "worker-event" to the webview)
  src/                        Vanilla TS + Vite UI: Status (§35), Settings (§36)
apps/worker/src/daemon/
  protocol.ts                 TypeBox request/response/event schemas
  daemon.ts                   stdio request loop, status events, runner lifecycle
  entry.ts                    daemon entry point; bundled by esbuild
apps/worker/src/lock.ts       single-instance lock shared by daemon and CLI `start`
```

Responsibilities:

| Unit          | Owns                                                              | Does not                                 |
| ------------- | ----------------------------------------------------------------- | ---------------------------------------- |
| Rust shell    | window, tray, `GetLastInputInfo` idle polling, spawn/restart/stop | read config, SQLite or the keyring       |
| Daemon (Node) | config, keyring, SQLite, budget, `WorkerRunner`, status events    | open sockets other than coordinator/APIs |
| UI (webview)  | rendering, form validation feedback                               | call anything except Tauri commands      |

## Worker changes

- `WorkerRunner` gains an optional `isIdle?: () => boolean` dependency. In
  `idle_only` mode it leases only while `isIdle()` is true. If the user returns
  mid-task, the current task is finished and no new lease is taken. Without an
  `isIdle` source (the CLI), `idle_only` is still refused at `init()`.
- New optional config field `schedule.idle_after_minutes` (integer 1–240, default 5).
  The daemon reports it in every status event, and the Rust idle detector takes it
  from there.
- `lock.ts`: an exclusive lock file `worker.lock` (containing the PID) in the data
  dir. Both the daemon and CLI `start` acquire it; a lock whose PID is no longer
  running is reclaimed. A second instance is refused with a clear message.

## Wire protocol

One JSON object per line, UTF-8, max 1 MB per line. Every inbound line is parsed
with `parse()` against the TypeBox schema; malformed, oversized or unknown-method
lines produce an error response (`bad_request`) and never terminate the loop.

- Request: `{ id: string, method, params }`
- Response: `{ id, ok: true, result }` or `{ id, ok: false, error: { code, message } }`
- Event: `{ event: 'status', data: DaemonStatus }`, pushed on every state change and
  at least every 5 s.

| Method                          | Behavior                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------- |
| `getStatus`                     | returns `DaemonStatus` (below)                                                                    |
| `getConfig`                     | returns the current `WorkerConfig` (contains no secrets)                                          |
| `saveConfig {config}`           | `validateConfig` + `validateCoordinatorUrl`; restarts the runner if coordinator/providers changed |
| `setMode {mode}`                | `active` / `paused` / `idle_only`, persisted to config; pausing remembers the previous mode       |
| `resume`                        | restores the mode that was active before the last pause (default `active`)                        |
| `setKey {provider, key}`        | writes the OS keyring only; the response never contains the key                                   |
| `deleteKey {provider}`          | removes the key from the keyring                                                                  |
| `probeProvider {id, endpoint?}` | `healthCheck()` + `getModels()`; returns models with `context_window`                             |
| `setIdle {idle}`                | Rust-only (not exposed as a webview command)                                                      |
| `shutdown`                      | drain: finish the current task, then exit 0                                                       |

`DaemonStatus`:

```ts
{
  connection: 'connected' | 'connecting' | 'offline' | 'unconfigured';
  worker_id?: string;
  coordinator_url: string;
  mode: 'active' | 'paused' | 'idle_only';
  idle: boolean;
  idle_after_minutes: number;
  current?: { project_id: string; project_name?: string; task_id: string };
  today: LocalTotals; month: LocalTotals;          // from localTotals()
  providers: { id: string; kind: 'local' | 'remote'; display_name: string;
               enabled: boolean; healthy: boolean | null;   // null = not checked yet
               requires_key: boolean; has_key: boolean }[];
  limits: { daily_usd: number; monthly_usd: number };
  last_error?: string;                              // passed through scrubSecrets()
}
```

The daemon logs only to its log file and stderr (`createFileAndStderrLogger`); stdout
is reserved for protocol lines. Rust continuously drains stderr so the pipe never
blocks the child.

## Rust shell

- **Supervisor:** spawns the daemon at startup. On an unexpected exit it restarts
  with backoff 1 s → 2 s → 4 s → 8 s; on the 5th crash within 5 minutes it stops and
  the UI shows "Worker stopped" with the last error and a Restart button.
- **Quit:** sends `shutdown`, waits up to 30 s, then kills the process. A kill
  mid-call is budget-safe: stale reservations are charged in full on next start.
- **Window close** hides to the tray; contribution continues. The tray menu offers
  Open, Pause/Resume and Quit; its tooltip reflects Contributing / Paused / Waiting
  for idle / Offline.
- **Idle detector:** polls `GetLastInputInfo` every 15 s and sends `setIdle` only
  on a state change, using `idle_after_minutes` from the config.
- **Single instance:** Tauri `single-instance` plugin (focuses the existing window),
  in addition to the daemon's lock file.
- **Relay:** line-framed; lines over 1 MB are dropped. A single `daemon_request`
  command forwards an allow-listed set of methods; `setIdle` and `shutdown` are
  reserved for the shell. Request parameters (which may contain an API key) are
  never logged.

## UI

Vanilla TS + Vite, with dashboard-style CSS tokens and dark mode. Compact window
(~420×640) with two tabs.

**Status (§35):**

- Status card: connection pill (Connected / Connecting / Offline / Paused / Waiting
  for idle), current project and task.
- Contribution today: tasks, tokens, API cost, plus a "this month" line.
- Resources: providers (enabled, healthy), daily and monthly API limits with spend
  meters (amber at 80%).
- Pause / Resume button.
- Banner with the scrubbed `last_error` and Restart when the daemon is down.

**Settings (§36):** a single page with an explicit Save button (no autosave).

- **Coordinator:** URL (validated), connection status, worker ID (read-only, copy).
- **Providers:**
  - Ollama: enable toggle, endpoint (default `http://localhost:11434`), and
    "Detect models" (`probeProvider`) filling a model checklist including
    `context_window`.
  - OpenAI: enable toggle, a write-only key field ("Key stored ✓" / "No key",
    Replace, Remove), and model + price per 1M input/output tokens (required).
  - Remote use is limited to the allowed projects.
  - Enabling any remote provider first shows `REMOTE_DISCLOSURE` in a
    confirmation dialog.
- **Limits:** daily and monthly USD (defaults $0 / $0; the form notes that $0
  means no paid calls). CPU limit and GPU preference are shown disabled and
  labelled "recorded, not yet enforced".
- **Schedule:** Always / Only while idle (idle-after-minutes) / Paused.
- **Projects:** all approved projects, or selected categories.

**Security:** CSP `default-src 'self'`; Tauri capabilities are limited to our
commands plus window and tray; no `shell`, `fs` or `http` plugin in the webview.
The key input is cleared immediately after submit.

## Out of scope (this milestone)

- Code signing, auto-update, CI desktop build job.
- §36 "custom schedule" (time windows).
- Enforcing CPU/GPU limits.
- macOS/Linux packaging (the code stays portable; the idle detector is Windows-only
  for now and reports "never idle" on other platforms).

## Testing

**Worker (vitest):**

- Protocol schemas: accept and reject cases.
- Daemon over in-memory streams with `MemorySecretStore`, fake fetch and a fake
  registry: every method round-trips; malformed, oversized and unknown lines are
  survived; `setKey` bytes never appear in any output stream or log; `saveConfig`
  rejects invalid config; status events are emitted on change.
- Runner idle mode: no lease while not idle; leasing starts when idle; a task that
  is running when the user returns completes and no new lease follows; the CLI
  still refuses `idle_only`.
- Lock: a second instance is refused; a stale lock is reclaimed.

**Desktop UI (vitest + happy-dom):**

- Status renders from fixtures: connected, offline with an error, paused, and
  waiting for idle.
- The settings form produces a valid `WorkerConfig`.
- The disclosure dialog gates enabling a remote provider.
- The key field clears after submit.

**Rust (`cargo test`):** line framing and the length cap; the idle state machine
with a fake clock; the supervisor backoff schedule.

**Manual end-to-end** (results recorded in PROGRESS.md):

1. Build and install the NSIS package; point it at a local coordinator and real
   Ollama `qwen3:4b`.
2. Complete the 20 demo tasks.
3. Pause and resume; run in idle_only.
4. Quit mid-task (it drains); kill mid-task and restart (the reservation is
   reconciled).
5. Grep the config, data dir and logs for the API key: it must not be present.

## Documentation

- New `docs/desktop.md`.
- Update `docs/worker.md` (daemon, idle, lock) and `docs/architecture.md`.
- Update PROGRESS.md and NEXT_STEPS.md at the end.
