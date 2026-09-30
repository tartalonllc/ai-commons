# Desktop worker (Windows)

`apps/desktop` is a Tauri v2 app that lets a non-developer volunteer install
and run the worker without a terminal. It wraps the same `apps/worker` code
the CLI uses; nothing about task execution, budget or credentials is
reimplemented.

## What it is

A small Rust shell (window, tray, idle detection, process supervision) that
starts the existing Node worker as a child process, a "daemon", and talks to
it over newline-delimited JSON on stdin/stdout. There are no listening ports:
opening one on a volunteer's machine would add a local attack surface for no
benefit, since the shell and the daemon are always on the same machine.

The daemon is a sidecar rather than a Rust port of the worker so there is
exactly one implementation of budget enforcement, credential handling and the
execution pipeline. Porting the pipeline to Rust would duplicate that logic
in a second language, and a second implementation that drifts from the first
is exactly the kind of gap that could let a spending limit be bypassed.

## Layout

| Path                                       | Responsibility                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `apps/desktop/src/`                        | Vanilla TS + Vite UI: `app.ts`, `status-view.ts`, `settings-view.ts`, `ipc.ts`, `dialog.ts`, `dom.ts`, `format.ts` |
| `apps/desktop/src-tauri/src/framing.rs`    | Newline framing and the 1 MB line cap for the daemon's stdout                                                      |
| `apps/desktop/src-tauri/src/idle.rs`       | `GetLastInputInfo` / `SHQueryUserNotificationState` idle detection                                                 |
| `apps/desktop/src-tauri/src/daemon.rs`     | Spawns `node.exe`, the stdio request/response/event plumbing, the Windows Job Object                               |
| `apps/desktop/src-tauri/src/supervisor.rs` | Restart backoff, quit draining, tray tooltip and menu state                                                        |
| `apps/desktop/src-tauri/src/lib.rs`        | Tauri commands, window/tray wiring, the `daemon_request` allow-list                                                |
| `apps/desktop/scripts/stage-runtime.ts`    | Copies `node.exe`, the daemon bundle and the keyring addon into `src-tauri/runtime/`                               |
| `apps/worker/src/daemon/*`                 | `protocol.ts` (wire schemas), `daemon.ts` (`WorkerDaemon`), `entry.ts` (process entry point)                       |

## Protocol

One JSON object per line, UTF-8, at most 1 MB per line (`DAEMON_MAX_LINE_BYTES`
in `protocol.ts`, mirrored by `MAX_LINE_BYTES` in `framing.rs`). A request is
`{ id, method, params }`; a response is `{ id, ok: true, result }` or
`{ id, ok: false, error: { code, message } }`; an event is
`{ event: 'status', data: DaemonStatus }`, pushed on every state change and at
least every 5 seconds.

| Method                          | Behavior                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------- |
| `getStatus`                     | Returns `DaemonStatus`                                                          |
| `getConfig`                     | Returns the current `WorkerConfig` (no secrets)                                 |
| `saveConfig {config}`           | Validates, then restarts the runner if the coordinator URL or providers changed |
| `setMode {mode}`                | `active` / `paused` / `idle_only`; pausing remembers the mode to resume into    |
| `resume`                        | Restores the mode from before the last pause (default `active`)                 |
| `setKey {provider, key}`        | Writes the OS keyring only; the response never contains the key                 |
| `deleteKey {provider}`          | Removes the key from the keyring                                                |
| `probeProvider {id, endpoint?}` | Health-checks the provider and returns its models with `context_window`         |
| `setIdle {idle}`                | Shell-only; the webview cannot call it                                          |
| `shutdown`                      | Drains (finishes the current task), then exits                                  |

`setIdle` and `shutdown` are reserved for the shell: the Rust `daemon_request`
command only forwards the methods in its `UI_METHODS` allow-list
(`apps/desktop/src-tauri/src/lib.rs`), so the webview cannot call either one
even if it tried. Request params can carry an API key (`setKey`), so the
daemon logs only the method name for every request, never `params`, and the
Rust relay never logs a line it forwards either.

`DaemonStatus` carries `connection`, `worker_id`, `coordinator_url`, `mode`,
`idle`, `idle_after_minutes`, the current task (if any), today's and this
month's local totals, each provider's enabled/healthy/has-key state, the
daily and monthly USD limits, and a scrubbed `last_error`.

## Supervision

The Rust `Supervisor` (`supervisor.rs`) starts the daemon at launch and
restarts it on an unexpected exit with backoff 1 s, 2 s, 4 s, 8 s. On the 5th
crash within 5 minutes it gives up and the UI shows "Worker stopped" with the
last error and a Restart button, which resets the crash history and tries
again. A user-requested restart (the Restart button) always resets the
backoff history too.

Quit (from the tray menu) hides the window, sets the tray tooltip and the UI
to a "stopping" state, sends `shutdown`, and waits up to 30 seconds for the
daemon to drain (finish its current task) before killing it. A kill mid-task
is budget-safe: a stranded reservation is charged in full the next time the
worker starts (`docs/worker.md`). Closing the window instead hides it to the
tray and leaves the worker running; Quit is only in the tray menu. The Tauri
`single-instance` plugin focuses the existing window if the app is launched
again, in addition to the daemon's own `worker.lock` file in the data
directory (`docs/worker.md`).

If the daemon can't be assigned to a Windows Job Object (see below), the
shell still runs it, but the "Running without crash cleanup" message replaces
the usual "running" state so the gap is visible instead of silent.

## Idle detection

The Rust shell polls `GetLastInputInfo` for time since the last keyboard or
mouse input, and `SHQueryUserNotificationState` for whether the user is busy
in a way input timing alone misses: a full-screen D3D app or presentation
mode also count as "not idle", so a game or video left full-screen blocks
contribution even with no input. Unknown idle time (the API call failing)
counts as in use, never as idle — a real reading is required before the
worker contributes. Polling is adaptive: every 2 seconds while idle, every 15
seconds while active, so returning to the machine stops work quickly and an
idle machine isn't polled needlessly often. `setIdle` is sent to the daemon
only on a state change; if that delivery fails, the tracker resets so the
next poll reports the state again rather than leaving the daemon on a stale
answer. A task already running when the user returns is finished; no new
lease is taken once the machine is no longer idle.

`GetLastInputInfo` is scoped to the calling process's session. It works only
when the shell runs in the interactive desktop session — it always reports
idle in session 0 (a Windows service), so the idle detector must run from the
tray app, never a background service.

## Security

- **Keys** go webview → Rust (`daemon_request`) → daemon stdin (`setKey`) →
  OS keyring. The key field in Settings is cleared immediately after submit,
  and the key is never echoed back, logged, or written to the config file.
- **CSP:** `default-src 'self'; style-src 'self'; connect-src ipc:
http://ipc.localhost; object-src 'none'; base-uri 'none'; form-action 'none';
frame-ancestors 'none'`.
- **Capabilities:** the `default` window capability grants only
  `core:event:allow-listen` and `core:event:allow-unlisten`
  (`apps/desktop/src-tauri/capabilities/default.json`). There is no `shell`,
  `fs` or `http` plugin, so the webview has no path to the filesystem or the
  network except through the app's own Tauri commands.
- **`daemon_request` allow-list:** only `getStatus`, `getConfig`,
  `saveConfig`, `setMode`, `resume`, `setKey`, `deleteKey` and `probeProvider`
  reach the daemon from the webview; `setIdle` and `shutdown` are sent only
  by the shell itself.
- **Windows Job Object:** the daemon's `node.exe` is assigned to a job with
  `KILL_ON_JOB_CLOSE`, so it cannot outlive the shell even if the shell
  crashes. If the job can't be created, the app still runs, with "Running
  without crash cleanup" shown instead.
- **Remote-provider disclosure:** enabling a remote (paid) provider in
  Settings shows `REMOTE_DISCLOSURE` (`apps/worker/src/disclosure.ts`) in a
  confirmation dialog first. This is enforced by the desktop UI (and by the
  CLI's `configure`), not by the daemon — the daemon only checks that the
  config it's given is well-formed and that remote endpoints use TLS.

## Build

```bash
pnpm build
pnpm --filter @ai-commons/desktop stage
cd apps/desktop && cargo tauri build
```

`stage` (`apps/desktop/scripts/stage-runtime.ts`) copies the currently
running Node binary into `src-tauri/runtime/`, so it must be run under Node
24 — the binary it copies is the one that ships in the installer. It also
copies the esbuild-bundled daemon (`worker-daemon.mjs` and its source map)
and the `@napi-rs/keyring` native module and its Windows x64 platform
package, since the native keyring addon can't be bundled into the daemon's
single JS file.

`cargo tauri dev` needs the runtime staged first (`pnpm --filter
@ai-commons/desktop stage`), since the dev build also spawns the staged
`node.exe`. `cargo test` needs `apps/desktop/dist` already built (`pnpm
--filter @ai-commons/desktop build`), because `tauri.conf.json` points
`frontendDist` there.

## Limitations

- The installer is unsigned; Windows SmartScreen warns on first run.
- Windows x64 only; the idle detector is Windows-only and `time_since_last_input`
  returns `None` (read as "not idle") on other platforms.
- No auto-update.
- No custom schedule windows (only Always / Only while idle / Paused).
- CPU and GPU limits are recorded in Settings but not enforced (same as the
  CLI worker; see `docs/worker.md`).
- Code signing and a CI desktop build job are out of scope for this
  milestone.
