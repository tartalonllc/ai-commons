# Desktop Worker (Windows, Tauri) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Windows desktop app (Tauri v2) that wraps the existing Node worker as a supervised stdio daemon, with the §35 status screen, §36 settings, real idle-only scheduling and an unsigned NSIS installer.

**Architecture:** The Rust shell owns the window, tray, idle detection (`GetLastInputInfo`) and process supervision. It starts a bundled `node.exe` running `worker-daemon.mjs` and relays newline-delimited JSON over stdin/stdout. All stateful logic (config, keyring, SQLite, budget, `WorkerRunner`) stays in `apps/worker`. The webview (vanilla TS + Vite) only calls Tauri commands. Spec: `docs/superpowers/specs/2026-09-28-desktop-worker-design.md`.

**Tech Stack:** TypeScript 6 (strict, `exactOptionalPropertyTypes`), TypeBox, vitest, happy-dom, Vite 8, esbuild; Rust 1.95, Tauri 2 (`tray-icon`), `tauri-plugin-single-instance`, tokio, `windows-sys`.

**Conventions (read once):**

- Work on branch `feature/desktop-worker` (it already exists and holds the spec).
- Every commit message ends with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. The commands below pass it as a second `-m`.
- Before every commit run `pnpm format` (Prettier rewrites files in place), then the task's test command.
- Coordinator tests need Docker Postgres (`docker compose up -d`). Worker and desktop tests do not.
- ESLint runs `tseslint.configs.strict`, so no `any` and no non-null `!` assertions. Tests use small helpers instead.
- Never log request params in the daemon or the Rust relay; `setKey` params carry API keys.

## File map

| File                                                                                              | Responsibility                                                                                                                 |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `apps/worker/src/config.ts` (modify)                                                              | `schedule.idle_after_minutes`, `DEFAULT_IDLE_AFTER_MINUTES`                                                                    |
| `apps/worker/src/lock.ts` (new)                                                                   | per-data-dir single-instance lock                                                                                              |
| `apps/worker/src/runner.ts` (modify)                                                              | `isIdle` dep, `mayLease()`, `onChange`, `snapshot()`, `activeProviderIds()`                                                    |
| `apps/worker/src/pipeline.ts` (modify)                                                            | `TaskExecutor.cachedProject()`                                                                                                 |
| `apps/worker/src/disclosure.ts` (new)                                                             | `REMOTE_DISCLOSURE`, dependency-free (imported by the webview)                                                                 |
| `apps/worker/src/commands.ts` (modify)                                                            | lock in `start`; re-export disclosure                                                                                          |
| `apps/worker/src/daemon/protocol.ts` (new)                                                        | wire types, per-method param schemas, `parseRequestLine()`                                                                     |
| `apps/worker/src/daemon/daemon.ts` (new)                                                          | `WorkerDaemon`: request loop, status events, runner lifecycle                                                                  |
| `apps/worker/src/daemon/entry.ts` (new)                                                           | process entry; bundled to `dist-daemon/worker-daemon.mjs`                                                                      |
| `apps/worker/scripts/bundle-daemon.ts` (new)                                                      | esbuild bundle script                                                                                                          |
| `apps/desktop/` (new package `@ai-commons/desktop`)                                               | Vite UI: `dom.ts`, `format.ts`, `ipc.ts`, `status-view.ts`, `settings-view.ts`, `app.ts`, `dialog.ts`, `main.ts`, `styles.css` |
| `apps/desktop/scripts/stage-runtime.ts` (new)                                                     | copies `node.exe`, the daemon bundle and the keyring addon into `src-tauri/runtime/`                                           |
| `apps/desktop/src-tauri/` (new)                                                                   | Rust: `framing.rs`, `idle.rs`, `daemon.rs`, `supervisor.rs`, `lib.rs`, `main.rs`                                               |
| `docs/desktop.md` (new), `docs/worker.md`, `docs/architecture.md`, `PROGRESS.md`, `NEXT_STEPS.md` | documentation                                                                                                                  |

---

## Phase A — Worker package

### Task 1: `schedule.idle_after_minutes` config field

**Files:**

- Modify: `apps/worker/src/config.ts` (the `schedule:` line inside `WorkerConfig`, around line 71)
- Test: `apps/worker/test/config-schedule.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// apps/worker/test/config-schedule.test.ts
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEFAULT_IDLE_AFTER_MINUTES,
  defaultConfig,
  validateConfig,
} from '../src/config.js';

function withIdle(value: unknown) {
  return { ...defaultConfig(), schedule: { mode: 'idle_only', idle_after_minutes: value } };
}

describe('schedule.idle_after_minutes', () => {
  it('is optional and defaults to 5 minutes', () => {
    expect(validateConfig(defaultConfig()).schedule.idle_after_minutes).toBeUndefined();
    expect(DEFAULT_IDLE_AFTER_MINUTES).toBe(5);
  });

  it('accepts whole minutes from 1 to 240', () => {
    expect(validateConfig(withIdle(1)).schedule.idle_after_minutes).toBe(1);
    expect(validateConfig(withIdle(240)).schedule.idle_after_minutes).toBe(240);
  });

  it('rejects out-of-range and fractional values', () => {
    for (const value of [0, 241, 2.5, '5']) {
      expect(() => validateConfig(withIdle(value))).toThrow(ConfigError);
    }
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @ai-commons/worker exec vitest run test/config-schedule.test.ts`
Expected: FAIL. `DEFAULT_IDLE_AFTER_MINUTES` is not exported, and `idle_after_minutes` is rejected as an unknown property.

- [ ] **Step 3: Implement**

In `apps/worker/src/config.ts`, add after the `ScheduleMode` type export:

```ts
/** Minutes without keyboard/mouse input before the desktop app treats the machine as idle. */
export const DEFAULT_IDLE_AFTER_MINUTES = 5;
```

Replace the `schedule:` property of `WorkerConfig`:

```ts
    schedule: Type.Object(
      {
        mode: ScheduleMode,
        /** Used by the desktop app's idle detector; see DEFAULT_IDLE_AFTER_MINUTES. */
        idle_after_minutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 240 })),
      },
      { additionalProperties: false },
    ),
```

- [ ] **Step 4: Run the test and the worker suite**

Run: `pnpm --filter @ai-commons/worker exec vitest run`
Expected: PASS (all worker tests).

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/worker/src/config.ts apps/worker/test/config-schedule.test.ts
git commit -m "Add schedule.idle_after_minutes to worker config" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Single-instance lock, used by CLI `start`

**Files:**

- Create: `apps/worker/src/lock.ts`
- Modify: `apps/worker/src/commands.ts` (`case 'start'`, around line 466), `apps/worker/src/index.ts`
- Test: `apps/worker/test/lock.test.ts` (new), `apps/worker/test/cli.test.ts` (add one test)

- [ ] **Step 1: Write the failing tests**

```ts
// apps/worker/test/lock.test.ts
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireInstanceLock, LOCK_FILE, LockHeldError, processAlive } from '../src/lock.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aic-lock-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const lockText = () => readFileSync(join(dir, LOCK_FILE), 'utf8');

describe('acquireInstanceLock', () => {
  it('refuses a second holder while the first is alive, and hands over on release', () => {
    const first = acquireInstanceLock(dir, { pid: 111, alive: () => true });
    expect(() => acquireInstanceLock(dir, { pid: 222, alive: () => true })).toThrow(LockHeldError);
    first.release();
    const second = acquireInstanceLock(dir, { pid: 222, alive: () => true });
    expect(lockText()).toBe('222');
    second.release();
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
  });

  it('names the holding process in the error', () => {
    acquireInstanceLock(dir, { pid: 111, alive: () => true });
    expect(() => acquireInstanceLock(dir, { pid: 222, alive: () => true })).toThrow(
      /already running \(process 111\)/,
    );
  });

  it('reclaims a lock left by a process that is gone', () => {
    writeFileSync(join(dir, LOCK_FILE), '999999');
    const lock = acquireInstanceLock(dir, { pid: 5, alive: () => false });
    expect(lockText()).toBe('5');
    lock.release();
  });

  it('reclaims a lock file with garbage content', () => {
    writeFileSync(join(dir, LOCK_FILE), 'not a pid');
    const lock = acquireInstanceLock(dir, { pid: 6, alive: () => true });
    expect(lockText()).toBe('6');
    lock.release();
  });

  it('does not delete a lock another process has taken over', () => {
    const lock = acquireInstanceLock(dir, { pid: 7, alive: () => true });
    writeFileSync(join(dir, LOCK_FILE), '8');
    lock.release();
    expect(lockText()).toBe('8');
  });

  it('detects the current process as alive', () => {
    expect(processAlive(process.pid)).toBe(true);
  });
});
```

Add to `apps/worker/test/cli.test.ts` (inside `describe('aicommons CLI', …)`, with `import { acquireInstanceLock } from '../src/lock.js';` at the top):

```ts
it('refuses to start while another worker holds the lock', async () => {
  const held = acquireInstanceLock(dir);
  try {
    const { context, err } = ctx();
    expect(await runCli(['start', '--max-tasks', '1'], context)).toBe(1);
    expect(err.join('\n')).toMatch(/already running/);
  } finally {
    held.release();
  }
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm --filter @ai-commons/worker exec vitest run test/lock.test.ts test/cli.test.ts`
Expected: FAIL. `../src/lock.js` cannot be resolved.

- [ ] **Step 3: Implement `lock.ts`**

```ts
// apps/worker/src/lock.ts
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export const LOCK_FILE = 'worker.lock';

export class LockHeldError extends Error {
  constructor(readonly pid: number) {
    super(
      `Another AI Commons worker is already running (process ${pid}). Stop it before starting a new one.`,
    );
    this.name = 'LockHeldError';
  }
}

export interface InstanceLock {
  release(): void;
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readHolder(file: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(file, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One contributing worker per data directory, shared by the desktop daemon and
 * `aicommons start`. A lock left by a crashed process (dead PID or unreadable
 * content) is reclaimed. Budget safety does not depend on this lock (reservations
 * are transactional); it prevents double contribution and duplicate heartbeats.
 */
export function acquireInstanceLock(
  dataDir: string,
  options: { pid?: number; alive?: (pid: number) => boolean } = {},
): InstanceLock {
  const pid = options.pid ?? process.pid;
  const alive = options.alive ?? processAlive;
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, LOCK_FILE);

  for (let attempt = 0; attempt < 3; attempt++) {
    let fd: number;
    try {
      fd = openSync(file, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = readHolder(file);
      if (holder !== undefined && alive(holder)) throw new LockHeldError(holder);
      try {
        unlinkSync(file);
      } catch {
        // Someone else reclaimed it first; try again.
      }
      continue;
    }
    try {
      writeSync(fd, String(pid));
    } finally {
      closeSync(fd);
    }
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        if (readHolder(file) !== pid) return;
        try {
          unlinkSync(file);
        } catch {
          // Already removed.
        }
      },
    };
  }
  throw new Error(`Could not acquire the worker lock at ${file}`);
}
```

Add to `apps/worker/src/index.ts`: `export * from './lock.js';`

- [ ] **Step 4: Use the lock in CLI `start`**

In `apps/worker/src/commands.ts`, add `import { acquireInstanceLock } from './lock.js';` and replace the body of `case 'start':` from `const config = await loadConfig(paths.configFile);` to the closing `return 0;` with:

```ts
const config = await loadConfig(paths.configFile);
const lock = acquireInstanceLock(paths.dataDir);
try {
  const logger = ctx.logger ?? createFileAndStderrLogger(config.log_level, paths.logFile);
  const db = new WorkerDatabase(paths.databaseFile);
  const runner = new WorkerRunner({
    db,
    secrets: secrets(),
    registry,
    logger,
    loadConfig: () => loadConfig(paths.configFile),
    saveConfig: (c) => saveConfig(paths.configFile, c),
    ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
  });
  const install =
    ctx.onSignal ??
    ((handler: () => void) => {
      process.on('SIGINT', handler);
      process.on('SIGTERM', handler);
    });
  install(() => {
    const phase = runner.requestStop();
    io.err(
      phase === 'draining'
        ? 'Finishing the current task before exiting (press Ctrl+C again to cancel it)...'
        : 'Cancelling the current task...',
    );
  });
  try {
    await runner.init();
    io.out(`Contributing as ${runner.workerId ?? 'unknown'}. Press Ctrl+C to stop.`);
    await runner.run(maxTasks === undefined ? {} : { maxTasks });
  } finally {
    db.close();
  }
} finally {
  lock.release();
}
return 0;
```

- [ ] **Step 5: Run the worker suite**

Run: `pnpm --filter @ai-commons/worker exec vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
pnpm format
git add apps/worker/src/lock.ts apps/worker/src/index.ts apps/worker/src/commands.ts apps/worker/test/lock.test.ts apps/worker/test/cli.test.ts
git commit -m "Add single-instance worker lock and use it in CLI start" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Idle-only scheduling in `WorkerRunner`

**Files:**

- Modify: `apps/worker/src/runner.ts` (`RunnerDeps`, `init()`, `status()`, the `run()` loop)
- Test: `apps/worker/test/runner.test.ts` (extend `Setup`/`makeRunner`, add a `describe`)

- [ ] **Step 1: Extend the test harness**

In `apps/worker/test/runner.test.ts`, add these fields to `interface Setup`:

```ts
  isIdle?: () => boolean;
  onChange?: () => void;
  fetch?: FetchFn;
```

Add `import type { FetchFn } from '../src/coordinator-client.js';`. In `makeRunner`, add these spreads to the `new WorkerRunner({ … })` argument, after `sleep`:

```ts
    ...(setup.isIdle ? { isIdle: setup.isIdle } : {}),
    ...(setup.onChange ? { onChange: setup.onChange } : {}),
    ...(setup.fetch ? { fetch: setup.fetch } : {}),
```

- [ ] **Step 2: Write the failing tests**

Append to `apps/worker/test/runner.test.ts`:

```ts
describe('idle-only scheduling', () => {
  it('is refused without an idle source', async () => {
    const local = new FakeProvider('ollama', 'local');
    await expect(
      makeRunner({ local, config: { schedule: { mode: 'idle_only' } } }),
    ).rejects.toThrow(/desktop app/);
  });

  it('waits until the machine is idle before leasing', async () => {
    coordinator.state.queue.push(leasedTask(1));
    let idle = false;
    let waits = 0;
    const local = new FakeProvider('ollama', 'local');
    const { runner, delays } = await makeRunner({
      local,
      config: { schedule: { mode: 'idle_only' } },
      isIdle: () => idle,
      onSleep: async () => {
        waits++;
        if (waits === 2) idle = true;
      },
    });
    await runner.run({ maxTasks: 1 });
    expect(delays.slice(0, 2)).toEqual([5_000, 5_000]);
    expect(coordinator.state.results).toHaveLength(1);
    expect((coordinator.state.heartbeats[0] as { status: string }).status).toBe('paused');
  });

  it('finishes the current task when the user returns, then stops leasing', async () => {
    coordinator.state.queue.push(leasedTask(1), leasedTask(2));
    let idle = true;
    let waits = 0;
    let stop: (() => void) | undefined;
    const local = new FakeProvider('ollama', 'local', [
      (req) => {
        idle = false; // the user moves the mouse mid-task
        return ok({ field: 'biology', confidence: 0.9 })(req);
      },
    ]);
    const { runner } = await makeRunner({
      local,
      config: { schedule: { mode: 'idle_only' } },
      isIdle: () => idle,
      onSleep: async () => {
        waits++;
        if (waits >= 3) stop?.();
      },
    });
    stop = () => runner.requestStop();
    await runner.run();
    expect(local.calls).toHaveLength(1);
    expect(coordinator.state.results).toHaveLength(1);
    expect(coordinator.state.queue).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run them and confirm they fail**

Run: `pnpm --filter @ai-commons/worker exec vitest run test/runner.test.ts`
Expected: FAIL. The first test gets "Idle-only scheduling is not supported yet", which doesn't match `/desktop app/`. The other two throw at init.

- [ ] **Step 4: Implement**

In `apps/worker/src/runner.ts`, add to `RunnerDeps`:

```ts
  /**
   * Idle source for `idle_only` mode. The desktop app feeds it from OS input idle
   * time. Without one, `idle_only` is refused at init.
   */
  isIdle?: () => boolean;
```

In `init()`, replace the `idle_only` guard with:

```ts
if (this.config.schedule.mode === 'idle_only' && !this.deps.isIdle) {
  throw new Error(
    'Idle-only scheduling needs the desktop app; use "active" or "paused" with the CLI.',
  );
}
```

Add this method to `WorkerRunner`, next to `status()`:

```ts
  /** Whether the schedule allows taking new work right now. A running task is never interrupted. */
  private mayLease(): boolean {
    switch (this.config.schedule.mode) {
      case 'active':
        return true;
      case 'idle_only':
        return this.deps.isIdle?.() ?? false;
      case 'paused':
        return false;
    }
  }
```

Replace `status()`:

```ts
  private status(): WorkerStatus {
    if (this.busy) return 'busy';
    return this.mayLease() ? 'available' : 'paused';
  }
```

In `run()`, replace `if (this.config.schedule.mode !== 'active') {` with `if (!this.mayLease()) {`.

- [ ] **Step 5: Run the worker suite**

Run: `pnpm --filter @ai-commons/worker exec vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
pnpm format
git add apps/worker/src/runner.ts apps/worker/test/runner.test.ts
git commit -m "Support idle-only scheduling with an injected idle source" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Observable runner state (`snapshot()`, `onChange`)

**Files:**

- Modify: `apps/worker/src/runner.ts`, `apps/worker/src/pipeline.ts` (`TaskExecutor`)
- Test: `apps/worker/test/runner.test.ts`

- [ ] **Step 1: Write the failing tests**

Add `type RunnerSnapshot` and `WorkerRunner` to the runner import in `runner.test.ts` (`import { WorkerRunner, type RunnerSnapshot } from '../src/runner.js';`), then append:

```ts
describe('runner snapshot', () => {
  it('reports connection, the current task, and change notifications', async () => {
    coordinator.state.queue.push(leasedTask(1));
    let changes = 0;
    let during: RunnerSnapshot | undefined;
    let runnerRef: WorkerRunner | undefined;
    const local = new FakeProvider('ollama', 'local', [
      (req) => {
        during = runnerRef?.snapshot();
        return ok({ field: 'biology', confidence: 0.9 })(req);
      },
    ]);
    const { runner } = await makeRunner({ local, onChange: () => changes++ });
    runnerRef = runner;
    expect(runner.snapshot()).toEqual({ connection: 'connected' });
    expect(runner.activeProviderIds()).toEqual(['ollama']);

    await runner.run({ maxTasks: 1 });

    expect(during).toEqual({
      connection: 'connected',
      current: {
        project_id: 'open-literature-demo',
        project_name: 'Open Literature Classification',
        task_id: 'task_000001',
      },
    });
    expect(runner.snapshot().current).toBeUndefined();
    expect(changes).toBeGreaterThanOrEqual(3);
  });

  it('goes offline with a readable error when the coordinator is unreachable', async () => {
    let stop: (() => void) | undefined;
    const local = new FakeProvider('ollama', 'local');
    const { runner } = await makeRunner({
      local,
      fetch: async (input, init) => {
        if (input.endsWith('/tasks/lease')) throw new TypeError('fetch failed');
        return fetch(input, init);
      },
      onSleep: async () => stop?.(),
    });
    stop = () => runner.requestStop();
    await runner.run();
    expect(runner.snapshot()).toEqual({
      connection: 'offline',
      last_error: 'coordinator unreachable (TypeError)',
    });
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm --filter @ai-commons/worker exec vitest run test/runner.test.ts`
Expected: FAIL. `runner.snapshot is not a function`.

- [ ] **Step 3: Add `cachedProject` to `TaskExecutor`**

In `apps/worker/src/pipeline.ts`, add to `class TaskExecutor`, after the constructor:

```ts
  /** Last loaded definition of a project, for status display only. */
  cachedProject(projectId: string): Project | undefined {
    return this.projects.get(projectId);
  }
```

- [ ] **Step 4: Implement the snapshot in `runner.ts`**

Add `import { scrubSecrets, type Logger } from './logger.js';` (replacing the existing `Logger` type import). Export these types above `RunnerDeps`:

```ts
export type ConnectionState = 'connecting' | 'connected' | 'offline';

export interface CurrentTask {
  project_id: string;
  project_name?: string;
  task_id: string;
}

export interface RunnerSnapshot {
  connection: ConnectionState;
  current?: CurrentTask;
  last_error?: string;
}
```

Add to `RunnerDeps`:

```ts
  /** Called whenever `snapshot()` may have changed (drives desktop status events). */
  onChange?: () => void;
```

Add these fields to `WorkerRunner`:

```ts
  private connection: ConnectionState = 'connecting';
  private lastError: string | undefined;
  private currentTask: { project_id: string; task_id: string } | undefined;
```

Add these methods:

```ts
  private changed(): void {
    this.deps.onChange?.();
  }

  private markConnected(): void {
    if (this.connection === 'connected' && this.lastError === undefined) return;
    this.connection = 'connected';
    this.lastError = undefined;
    this.changed();
  }

  private markOffline(error: unknown): void {
    this.connection = 'offline';
    const text = error instanceof Error ? error.message : String(error);
    this.lastError = scrubSecrets(text, this.knownSecrets());
    this.changed();
  }

  snapshot(): RunnerSnapshot {
    const snap: RunnerSnapshot = { connection: this.connection };
    if (this.currentTask) {
      const name = this.executor.cachedProject(this.currentTask.project_id)?.name;
      snap.current =
        name === undefined ? { ...this.currentTask } : { ...this.currentTask, project_name: name };
    }
    if (this.lastError !== undefined) snap.last_error = this.lastError;
    return snap;
  }

  /** Providers that passed health checks at init; undefined before init completes. */
  activeProviderIds(): string[] | undefined {
    return this.session ? this.providers.map((p) => p.provider.id) : undefined;
  }
```

Wire them in:

1. At the end of `init()`, after `this.executor = new TaskExecutor({ … });`, add `this.markConnected();`.
2. In `run()`, in the lease `try`, after `backoff = 1_000;` add `this.markConnected();`.
3. In the lease `catch`, add `this.markOffline(error);` as its first statement.
4. Replace the task block (`this.busy = true; try { … } finally { … }`) with:

```ts
this.busy = true;
this.currentTask = { project_id: leased.task.project_id, task_id: leased.task.id };
this.changed();
try {
  const outcome = await this.executor.run(leased.task, this.hardStop.signal);
  this.outcomes.push(outcome);
} finally {
  this.busy = false;
  this.currentTask = undefined;
  processed++;
  this.changed();
}
```

- [ ] **Step 5: Run the worker suite**

Run: `pnpm --filter @ai-commons/worker exec vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
pnpm format
git add apps/worker/src/runner.ts apps/worker/src/pipeline.ts apps/worker/test/runner.test.ts
git commit -m "Expose runner connection, current task and change notifications" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Browser-safe `REMOTE_DISCLOSURE` module

**Files:**

- Create: `apps/worker/src/disclosure.ts`
- Modify: `apps/worker/src/commands.ts` (remove the `REMOTE_DISCLOSURE` const, lines 41–44), `apps/worker/package.json` (`exports`)
- Test: `apps/worker/test/disclosure.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// apps/worker/test/disclosure.test.ts
import { describe, expect, it } from 'vitest';
import * as commands from '../src/commands.js';
import { REMOTE_DISCLOSURE } from '../src/disclosure.js';

describe('REMOTE_DISCLOSURE', () => {
  it('is shared by the CLI and the desktop app', () => {
    expect(commands.REMOTE_DISCLOSURE).toBe(REMOTE_DISCLOSURE);
    expect(REMOTE_DISCLOSURE).toMatch(/full task input/);
    expect(REMOTE_DISCLOSURE).toMatch(/local_models_only/);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @ai-commons/worker exec vitest run test/disclosure.test.ts`
Expected: FAIL. `../src/disclosure.js` cannot be resolved.

- [ ] **Step 3: Implement**

```ts
// apps/worker/src/disclosure.ts
/**
 * Shown before a volunteer enables a remote provider, by the CLI (`configure`) and
 * by the desktop Settings screen. Keep this module dependency-free: the desktop
 * webview imports it.
 */
export const REMOTE_DISCLOSURE =
  'Note: remote providers receive the full task input for every task they process. ' +
  'Only projects you allow will ever be sent to a remote provider, and projects marked ' +
  'local_models_only are never sent.';
```

In `commands.ts`, delete the `export const REMOTE_DISCLOSURE = …;` statement and add near the other imports:

```ts
import { REMOTE_DISCLOSURE } from './disclosure.js';

export { REMOTE_DISCLOSURE };
```

In `apps/worker/package.json`, extend `exports`:

```json
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./disclosure": {
      "types": "./dist/disclosure.d.ts",
      "import": "./dist/disclosure.js"
    }
  },
```

- [ ] **Step 4: Run the worker suite**

Run: `pnpm --filter @ai-commons/worker exec vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/worker/src/disclosure.ts apps/worker/src/commands.ts apps/worker/package.json apps/worker/test/disclosure.test.ts
git commit -m "Move remote-provider disclosure into a browser-safe module" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Daemon wire protocol

**Files:**

- Create: `apps/worker/src/daemon/protocol.ts`
- Modify: `apps/worker/src/index.ts`
- Test: `apps/worker/test/daemon-protocol.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// apps/worker/test/daemon-protocol.test.ts
import { describe, expect, it } from 'vitest';
import { DAEMON_MAX_LINE_BYTES, parseRequestLine } from '../src/daemon/protocol.js';

describe('parseRequestLine', () => {
  it('accepts a valid request', () => {
    expect(parseRequestLine('{"id":"1","method":"setMode","params":{"mode":"paused"}}')).toEqual({
      ok: true,
      id: '1',
      method: 'setMode',
      params: { mode: 'paused' },
    });
  });

  it('treats missing params as an empty object', () => {
    expect(parseRequestLine('{"id":"2","method":"getStatus"}')).toEqual({
      ok: true,
      id: '2',
      method: 'getStatus',
      params: {},
    });
  });

  it('rejects non-JSON with a null id', () => {
    expect(parseRequestLine('hello')).toMatchObject({ ok: false, id: null, code: 'bad_request' });
  });

  it('rejects oversized lines before parsing them', () => {
    const line = JSON.stringify({
      id: '3',
      method: 'getStatus',
      params: { pad: 'x'.repeat(DAEMON_MAX_LINE_BYTES) },
    });
    expect(parseRequestLine(line)).toMatchObject({ ok: false, id: null, code: 'bad_request' });
  });

  it('rejects unknown methods, including inherited property names', () => {
    expect(parseRequestLine('{"id":"4","method":"formatDisk"}')).toMatchObject({
      ok: false,
      id: '4',
      code: 'unknown_method',
    });
    expect(parseRequestLine('{"id":"5","method":"toString"}')).toMatchObject({
      ok: false,
      code: 'unknown_method',
    });
  });

  it('rejects invalid params and reports the path', () => {
    const result = parseRequestLine('{"id":"6","method":"setMode","params":{"mode":"turbo"}}');
    expect(result).toMatchObject({ ok: false, id: '6', code: 'bad_request' });
    expect(result.ok ? '' : result.message).toContain('/mode');
  });

  it('rejects unexpected envelope fields and overlong keys', () => {
    expect(parseRequestLine('{"id":"7","method":"getStatus","extra":1}')).toMatchObject({
      ok: false,
      code: 'bad_request',
    });
    const key = 'k'.repeat(5000);
    expect(
      parseRequestLine(
        JSON.stringify({ id: '8', method: 'setKey', params: { provider: 'openai', key } }),
      ),
    ).toMatchObject({ ok: false, code: 'bad_request' });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @ai-commons/worker exec vitest run test/daemon-protocol.test.ts`
Expected: FAIL. The module does not exist.

- [ ] **Step 3: Implement**

```ts
// apps/worker/src/daemon/protocol.ts
import { parse, ProviderId, type ValidationIssue } from '@ai-commons/protocol';
import Type, { type Static } from 'typebox';
import { ScheduleMode } from '../config.js';
import type { LocalTotals } from '../stats.js';
import type { CurrentTask } from '../runner.js';

/**
 * Newline-delimited JSON over stdio between the desktop shell and the worker
 * daemon. Mirrored by `MAX_LINE_BYTES` in apps/desktop/src-tauri/src/framing.rs.
 */
export const DAEMON_MAX_LINE_BYTES = 1_000_000;

export const RequestEnvelope = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 64 }),
    method: Type.String({ minLength: 1, maxLength: 64 }),
    params: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

const Empty = Type.Object({}, { additionalProperties: false });

export const MethodParams = {
  getStatus: Empty,
  getConfig: Empty,
  saveConfig: Type.Object({ config: Type.Unknown() }, { additionalProperties: false }),
  setMode: Type.Object({ mode: ScheduleMode }, { additionalProperties: false }),
  resume: Empty,
  setKey: Type.Object(
    { provider: ProviderId, key: Type.String({ minLength: 1, maxLength: 4096 }) },
    { additionalProperties: false },
  ),
  deleteKey: Type.Object({ provider: ProviderId }, { additionalProperties: false }),
  probeProvider: Type.Object(
    { id: ProviderId, endpoint: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })) },
    { additionalProperties: false },
  ),
  /** Sent by the desktop shell only; the webview cannot call it. */
  setIdle: Type.Object({ idle: Type.Boolean() }, { additionalProperties: false }),
  shutdown: Empty,
} as const;

export type DaemonMethod = keyof typeof MethodParams;
export type MethodParamsOf<M extends DaemonMethod> = Static<(typeof MethodParams)[M]>;

export type DaemonErrorCode =
  'bad_request' | 'unknown_method' | 'invalid_config' | 'unavailable' | 'internal';

export interface ProviderStatus {
  id: string;
  kind: 'local' | 'remote';
  display_name: string;
  enabled: boolean;
  /** null until the worker has checked providers. */
  healthy: boolean | null;
  requires_key: boolean;
  has_key: boolean;
}

export interface DaemonStatus {
  connection: 'connected' | 'connecting' | 'offline' | 'unconfigured';
  worker_id?: string;
  coordinator_url: string;
  mode: ScheduleMode;
  idle: boolean;
  idle_after_minutes: number;
  current?: CurrentTask;
  today: LocalTotals;
  month: LocalTotals;
  providers: ProviderStatus[];
  limits: { daily_usd: number; monthly_usd: number };
  /** Always passed through scrubSecrets(). */
  last_error?: string;
}

export interface ProbeResult {
  ok: boolean;
  message?: string;
  models: { name: string; context_window?: number }[];
}

export type DaemonResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string | null; ok: false; error: { code: DaemonErrorCode; message: string } };

export interface DaemonEvent {
  event: 'status';
  data: DaemonStatus;
}

export type ParsedRequest =
  | { ok: true; id: string; method: DaemonMethod; params: unknown }
  | { ok: false; id: string | null; code: DaemonErrorCode; message: string };

function isMethod(name: string): name is DaemonMethod {
  return Object.hasOwn(MethodParams, name);
}

function describeIssues(issues: ValidationIssue[]): string {
  return issues
    .slice(0, 3)
    .map((i) => `${i.path}: ${i.message}`)
    .join('; ');
}

/** Validates one inbound line. Never throws. */
export function parseRequestLine(line: string): ParsedRequest {
  if (Buffer.byteLength(line, 'utf8') > DAEMON_MAX_LINE_BYTES) {
    return { ok: false, id: null, code: 'bad_request', message: 'Request is too large' };
  }
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return { ok: false, id: null, code: 'bad_request', message: 'Request is not valid JSON' };
  }
  const envelope = parse(RequestEnvelope, json);
  if (!envelope.ok) {
    return {
      ok: false,
      id: null,
      code: 'bad_request',
      message: `Invalid request: ${describeIssues(envelope.issues)}`,
    };
  }
  const { id, method } = envelope.value;
  if (!isMethod(method)) {
    return { ok: false, id, code: 'unknown_method', message: `Unknown method "${method}"` };
  }
  const params = parse(MethodParams[method], envelope.value.params ?? {});
  if (!params.ok) {
    return {
      ok: false,
      id,
      code: 'bad_request',
      message: `Invalid params: ${describeIssues(params.issues)}`,
    };
  }
  return { ok: true, id, method, params: params.value };
}
```

Add to `apps/worker/src/index.ts`: `export * from './daemon/protocol.js';`

- [ ] **Step 4: Run the tests and typecheck**

Run: `pnpm --filter @ai-commons/worker exec vitest run test/daemon-protocol.test.ts && pnpm --filter @ai-commons/worker typecheck`
Expected: PASS, and the typecheck is clean.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/worker/src/daemon/protocol.ts apps/worker/src/index.ts apps/worker/test/daemon-protocol.test.ts
git commit -m "Define the worker daemon stdio protocol" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `WorkerDaemon`

**Files:**

- Create: `apps/worker/src/daemon/daemon.ts`
- Modify: `apps/worker/src/index.ts`
- Test: `apps/worker/test/daemon.test.ts` (new)

**Behavior summary:**

- **Startup:** takes the instance lock and opens SQLite, then loads the config and caches which providers have keys. After that it starts reading stdin, emits status every `statusIntervalMs` (default 5 s), and starts the runner if the worker is configured.
- **Runner lifecycle:** every start, stop and restart runs through one serialized promise chain (`enqueue`), so they never interleave. If init or run fails, it retries after `restartDelayMs` (default 30 s).
- **Shutdown:** triggered by `shutdown` or stdin EOF. It drains the runner, then closes the DB and releases the lock. A second shutdown cancels the running task.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/worker/test/daemon.test.ts
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, saveConfig, type WorkerConfig } from '../src/config.js';
import { WorkerDaemon } from '../src/daemon/daemon.js';
import type { DaemonStatus, ProbeResult } from '../src/daemon/protocol.js';
import { acquireInstanceLock } from '../src/lock.js';
import type { WorkerPaths } from '../src/paths.js';
import { abortableSleep } from '../src/pipeline.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { MemorySecretStore, secretAccounts } from '../src/secrets.js';
import { captureLogger, FakeCoordinator, FakeProvider, leasedTask, testConfig } from './helpers.js';

const API_KEY = 'sk-test-DAEMONSECRET1234567890';
type Message = Record<string, unknown>;

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

class Harness {
  readonly input = new PassThrough();
  readonly output = new PassThrough();
  readonly messages: Message[] = [];
  private raw = '';
  private buffer = '';
  private next = 0;

  constructor() {
    this.output.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      this.raw += text;
      this.buffer += text;
      for (let i = this.buffer.indexOf('\n'); i >= 0; i = this.buffer.indexOf('\n')) {
        this.messages.push(JSON.parse(this.buffer.slice(0, i)) as Message);
        this.buffer = this.buffer.slice(i + 1);
      }
    });
  }

  send(line: string): void {
    this.input.write(`${line}\n`);
  }

  async request(method: string, params?: unknown): Promise<Message> {
    const id = `t${++this.next}`;
    this.send(JSON.stringify(params === undefined ? { id, method } : { id, method, params }));
    await until(() => this.messages.some((m) => m.id === id));
    return this.messages.find((m) => m.id === id) as Message;
  }

  async status(): Promise<DaemonStatus> {
    return (await this.request('getStatus')).result as DaemonStatus;
  }

  responses(): Message[] {
    return this.messages.filter((m) => 'id' in m);
  }

  events(): DaemonStatus[] {
    return this.messages.filter((m) => m.event === 'status').map((m) => m.data as DaemonStatus);
  }

  text(): string {
    return this.raw;
  }
}

interface Started {
  daemon: WorkerDaemon;
  h: Harness;
  paths: WorkerPaths;
  secrets: MemorySecretStore;
  log: ReturnType<typeof captureLogger>;
}

let dir: string;
let coordinator: FakeCoordinator;
let started: Started | undefined;

async function startDaemon(
  opts: { configured?: boolean; config?: Partial<WorkerConfig> } = {},
): Promise<Started> {
  const paths: WorkerPaths = {
    configDir: dir,
    dataDir: dir,
    configFile: join(dir, 'config.json'),
    databaseFile: join(dir, 'worker.db'),
    logFile: join(dir, 'worker.log'),
  };
  if (opts.configured !== false) {
    await saveConfig(paths.configFile, testConfig(coordinator.url, opts.config));
  }
  const secrets = new MemorySecretStore();
  const local = new FakeProvider('ollama', 'local');
  const registry = new ProviderRegistry()
    .register({
      id: 'ollama',
      kind: 'local',
      displayName: 'Ollama (local)',
      requiresKey: false,
      factory: async () => local,
    })
    .register({
      id: 'openai',
      kind: 'remote',
      displayName: 'OpenAI API',
      requiresKey: true,
      factory: async () => {
        throw new Error('invalid key sk-live-abcdefghijklmnop');
      },
    });
  const log = captureLogger();
  const h = new Harness();
  const daemon = new WorkerDaemon({
    paths,
    secrets,
    registry,
    logger: log.logger,
    input: h.input,
    output: h.output,
    statusIntervalMs: 50,
    restartDelayMs: 50,
    runnerOverrides: { sleep: (ms, signal) => abortableSleep(Math.min(ms, 20), signal) },
  });
  await daemon.start();
  started = { daemon, h, paths, secrets, log };
  return started;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aic-daemon-'));
  coordinator = await new FakeCoordinator().start();
});

afterEach(async () => {
  if (started) await started.daemon.shutdown();
  started = undefined;
  await coordinator.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('WorkerDaemon', () => {
  it('reports unconfigured before setup and lists every provider', async () => {
    const { h } = await startDaemon({ configured: false });
    const status = await h.status();
    expect(status).toMatchObject({
      connection: 'unconfigured',
      mode: 'active',
      idle: false,
      idle_after_minutes: 5,
      limits: { daily_usd: 0, monthly_usd: 0 },
    });
    expect(status.providers.map((p) => [p.id, p.enabled, p.requires_key, p.has_key])).toEqual([
      ['ollama', true, false, false],
      ['openai', false, true, false],
    ]);
    expect(coordinator.state.registrations).toBe(0);
  });

  it('survives malformed, oversized, and unknown requests', async () => {
    const { h } = await startDaemon({ configured: false });
    h.send('this is not json');
    h.send(
      JSON.stringify({ id: 'big', method: 'getStatus', params: { pad: 'x'.repeat(1_000_001) } }),
    );
    h.send(JSON.stringify({ id: 'u1', method: 'formatDisk' }));
    await until(() => h.responses().filter((r) => r.ok === false).length === 3);
    expect(h.responses().filter((r) => r.id === null)).toHaveLength(2);
    expect(h.responses().find((r) => r.id === 'u1')).toMatchObject({
      error: { code: 'unknown_method' },
    });
    expect((await h.request('getStatus')).ok).toBe(true);
  });

  it('validates and saves config, then starts contributing', async () => {
    coordinator.state.queue.push(leasedTask(1));
    const { h, paths } = await startDaemon({ configured: false });
    const bad = await h.request('saveConfig', {
      config: { ...testConfig(coordinator.url), coordinator_url: 'ftp://example.org' },
    });
    expect(bad).toMatchObject({ ok: false, error: { code: 'invalid_config' } });

    const good = await h.request('saveConfig', { config: testConfig(coordinator.url) });
    expect(good.ok).toBe(true);
    await until(() => coordinator.state.results.length === 1);
    await until(() => h.events().some((e) => e.today.tasks_submitted === 1));

    const status = await h.status();
    expect(status.connection).toBe('connected');
    expect(status.worker_id).toBe('worker_test1');
    expect(status.providers.find((p) => p.id === 'ollama')?.healthy).toBe(true);
    expect((await loadConfig(paths.configFile)).coordinator_url).toBe(coordinator.url);
  });

  it('emits periodic status events', async () => {
    const { h } = await startDaemon();
    await until(() => h.events().length >= 3);
  });

  it('in idle_only mode contributes only after the shell reports idle', async () => {
    coordinator.state.queue.push(leasedTask(1));
    const { h } = await startDaemon({ config: { schedule: { mode: 'idle_only' } } });
    await until(() => h.events().some((e) => e.connection === 'connected'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(coordinator.state.results).toHaveLength(0);

    expect(await h.request('setIdle', { idle: true })).toMatchObject({
      ok: true,
      result: { idle: true },
    });
    await until(() => coordinator.state.results.length === 1);
    expect((await h.status()).idle).toBe(true);
  });

  it('pauses and resumes to the previous mode', async () => {
    const { h, paths } = await startDaemon({ config: { schedule: { mode: 'idle_only' } } });
    expect((await h.request('setMode', { mode: 'paused' })).result).toEqual({ mode: 'paused' });
    expect((await loadConfig(paths.configFile)).schedule.mode).toBe('paused');
    expect((await h.request('resume')).result).toEqual({ mode: 'idle_only' });
    expect((await loadConfig(paths.configFile)).schedule.mode).toBe('idle_only');
  });

  it('refuses mode changes before setup', async () => {
    const { h } = await startDaemon({ configured: false });
    expect(await h.request('setMode', { mode: 'paused' })).toMatchObject({
      ok: false,
      error: { code: 'bad_request' },
    });
  });

  it('stores API keys only in the keyring and never echoes or logs them', async () => {
    const { h, secrets, log, paths } = await startDaemon();
    expect(await h.request('setKey', { provider: 'openai', key: API_KEY })).toMatchObject({
      ok: true,
      result: { stored: true },
    });
    expect(await secrets.get(secretAccounts.provider('openai'))).toBe(API_KEY);
    expect((await h.status()).providers.find((p) => p.id === 'openai')?.has_key).toBe(true);

    expect(h.text()).not.toContain(API_KEY);
    expect(log.text()).not.toContain(API_KEY);
    expect(readFileSync(paths.configFile, 'utf8')).not.toContain(API_KEY);

    expect((await h.request('deleteKey', { provider: 'openai' })).result).toEqual({
      removed: true,
    });
    expect((await h.status()).providers.find((p) => p.id === 'openai')?.has_key).toBe(false);
    expect(await h.request('setKey', { provider: 'ollama', key: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'bad_request' },
    });
  });

  it('probes providers for models and scrubs failures', async () => {
    const { h } = await startDaemon();
    const found = await h.request('probeProvider', {
      id: 'ollama',
      endpoint: 'http://localhost:11434',
    });
    expect(found.result).toEqual({
      ok: true,
      models: [{ name: 'test-model', context_window: 32_768 }],
    });

    const failed = (await h.request('probeProvider', { id: 'openai' })).result as ProbeResult;
    expect(failed.ok).toBe(false);
    expect(failed.message).toContain('[redacted]');
    expect(failed.message).not.toContain('abcdefghijklmnop');

    expect(
      await h.request('probeProvider', { id: 'ollama', endpoint: 'file:///etc/passwd' }),
    ).toMatchObject({ ok: false, error: { code: 'bad_request' } });
  });

  it('reports offline instead of contributing when another worker holds the lock', async () => {
    const held = acquireInstanceLock(dir);
    try {
      const { h } = await startDaemon();
      const status = await h.status();
      expect(status.connection).toBe('offline');
      expect(status.last_error).toMatch(/already running/);
      expect(coordinator.state.registrations).toBe(0);
    } finally {
      held.release();
    }
  });

  it('drains and finishes on a shutdown request', async () => {
    const { h, daemon } = await startDaemon();
    await until(() => h.events().some((e) => e.connection === 'connected'));
    expect((await h.request('shutdown')).result).toEqual({ stopping: true });
    await daemon.finished();
  });

  it('shuts down when stdin closes', async () => {
    const { h, daemon } = await startDaemon();
    h.input.end();
    await daemon.finished();
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm --filter @ai-commons/worker exec vitest run test/daemon.test.ts`
Expected: FAIL. `../src/daemon/daemon.js` cannot be resolved.

- [ ] **Step 3: Implement `daemon.ts`**

```ts
// apps/worker/src/daemon/daemon.ts
import { createInterface, type Interface } from 'node:readline';
import {
  ConfigError,
  configExists,
  DEFAULT_IDLE_AFTER_MINUTES,
  defaultConfig,
  loadConfig,
  saveConfig as writeConfigFile,
  validateConfig,
  type ProviderConfig,
  type ScheduleMode,
  type WorkerConfig,
} from '../config.js';
import type { FetchFn } from '../coordinator-client.js';
import { WorkerDatabase } from '../db.js';
import { acquireInstanceLock, type InstanceLock } from '../lock.js';
import { scrubSecrets, type Logger } from '../logger.js';
import type { WorkerPaths } from '../paths.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { WorkerRunner, type RunnerDeps } from '../runner.js';
import { secretAccounts, SecretStoreUnavailableError, type SecretStore } from '../secrets.js';
import { localTotals, type LocalTotals } from '../stats.js';
import {
  parseRequestLine,
  type DaemonErrorCode,
  type DaemonEvent,
  type DaemonMethod,
  type DaemonResponse,
  type DaemonStatus,
  type MethodParamsOf,
  type ProbeResult,
  type ProviderStatus,
} from './protocol.js';

const RESUME_MODE_SETTING = 'resume_mode';

export class DaemonError extends Error {
  constructor(
    readonly code: DaemonErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DaemonError';
  }
}

export interface DaemonDeps {
  paths: WorkerPaths;
  secrets: SecretStore;
  registry: ProviderRegistry;
  logger: Logger;
  /** Requests, one JSON object per line (process.stdin in production). */
  input: NodeJS.ReadableStream;
  /** Responses and events (process.stdout). Nothing else may write here. */
  output: NodeJS.WritableStream;
  fetch?: FetchFn;
  now?: () => number;
  statusIntervalMs?: number;
  restartDelayMs?: number;
  runnerOverrides?: Pick<RunnerDeps, 'sleep' | 'retryDelaysMs'>;
  acquireLock?: (dataDir: string) => InstanceLock;
}

function emptyTotals(): LocalTotals {
  return {
    tasks_submitted: 0,
    tasks_failed: 0,
    input_tokens: 0,
    output_tokens: 0,
    local_inference_ms: 0,
    api_cost_usd: 0,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function needsRestart(prev: WorkerConfig, next: WorkerConfig): boolean {
  return (
    prev.coordinator_url !== next.coordinator_url ||
    JSON.stringify(prev.providers) !== JSON.stringify(next.providers)
  );
}

/**
 * The desktop app's view of the worker: a stdio request loop around one
 * WorkerRunner. API keys go straight to the SecretStore and are never echoed,
 * logged or persisted.
 */
export class WorkerDaemon {
  private config: WorkerConfig = defaultConfig();
  private configured = false;
  private db: WorkerDatabase | undefined;
  private lock: InstanceLock | undefined;
  private runner: WorkerRunner | undefined;
  private runLoop: Promise<void> | undefined;
  private intentionalStop = false;
  private idle = false;
  private readonly keys = new Map<string, boolean>();
  private lastError: string | undefined;
  private lifecycle: Promise<void> = Promise.resolve();
  private retryTimer: NodeJS.Timeout | undefined;
  private statusTimer: NodeJS.Timeout | undefined;
  private lines: Interface | undefined;
  private stopping = false;
  private closed = false;
  private resolveFinished: () => void = () => undefined;
  private readonly finishedPromise = new Promise<void>((resolve) => {
    this.resolveFinished = resolve;
  });

  constructor(private readonly deps: DaemonDeps) {}

  async start(): Promise<void> {
    const { paths, logger } = this.deps;
    try {
      this.lock = (this.deps.acquireLock ?? acquireInstanceLock)(paths.dataDir);
      this.db = new WorkerDatabase(paths.databaseFile);
    } catch (error) {
      this.lock?.release();
      this.lock = undefined;
      this.lastError = this.scrub(error);
      logger.error({ err: this.lastError }, 'worker daemon cannot contribute');
    }
    try {
      this.configured = await configExists(paths.configFile);
      this.config = await loadConfig(paths.configFile);
    } catch (error) {
      this.configured = false;
      this.lastError = this.scrub(error);
    }
    await this.refreshKeys();

    this.lines = createInterface({ input: this.deps.input, crlfDelay: Infinity });
    this.lines.on('line', (line) => void this.handleLine(line));
    this.lines.on('close', () => void this.shutdown());
    this.statusTimer = setInterval(() => this.emitStatus(), this.deps.statusIntervalMs ?? 5_000);
    this.statusTimer.unref();
    this.emitStatus();
    void this.enqueue(() => this.startRunner());
  }

  finished(): Promise<void> {
    return this.finishedPromise;
  }

  /** First call drains (finishes the current task); a second call cancels it. */
  async shutdown(): Promise<void> {
    if (this.stopping) {
      this.runner?.requestStop();
      return this.finishedPromise;
    }
    this.stopping = true;
    clearInterval(this.statusTimer);
    clearTimeout(this.retryTimer);
    this.emitStatus();
    await this.enqueue(() => this.stopRunner());
    this.closed = true;
    this.lines?.close();
    this.db?.close();
    this.lock?.release();
    this.resolveFinished();
  }

  status(): DaemonStatus {
    const snap = this.runner?.snapshot();
    const active = this.runner?.activeProviderIds();
    const totals = this.db ? localTotals(this.db, (this.deps.now ?? Date.now)()) : undefined;
    const connection: DaemonStatus['connection'] = !this.db
      ? 'offline'
      : !this.configured
        ? 'unconfigured'
        : (snap?.connection ?? (this.lastError === undefined ? 'connecting' : 'offline'));
    const providers: ProviderStatus[] = this.deps.registry.list().map((reg) => {
      const cfg = this.config.providers.find((p) => p.id === reg.id);
      return {
        id: reg.id,
        kind: reg.kind,
        display_name: reg.displayName,
        enabled: cfg?.enabled ?? false,
        healthy: active === undefined ? null : active.includes(reg.id),
        requires_key: reg.requiresKey,
        has_key: this.keys.get(reg.id) ?? false,
      };
    });
    const status: DaemonStatus = {
      connection,
      coordinator_url: this.config.coordinator_url,
      mode: this.config.schedule.mode,
      idle: this.idle,
      idle_after_minutes: this.config.schedule.idle_after_minutes ?? DEFAULT_IDLE_AFTER_MINUTES,
      today: totals?.today ?? emptyTotals(),
      month: totals?.month ?? emptyTotals(),
      providers,
      limits: { ...this.config.limits.api },
    };
    const workerId = this.runner?.workerId ?? this.config.worker_id;
    if (workerId !== undefined) status.worker_id = workerId;
    if (snap?.current) status.current = snap.current;
    const lastError = snap?.last_error ?? this.lastError;
    if (lastError !== undefined) status.last_error = lastError;
    return status;
  }

  // ---- requests ----

  private async handleLine(line: string): Promise<void> {
    if (line.trim() === '') return;
    const request = parseRequestLine(line);
    if (!request.ok) {
      this.send({
        id: request.id,
        ok: false,
        error: { code: request.code, message: request.message },
      });
      return;
    }
    // Method names only: params may contain an API key.
    this.deps.logger.debug({ method: request.method }, 'daemon request');
    try {
      const result = await this.dispatch(request.method, request.params);
      this.send({ id: request.id, ok: true, result });
    } catch (error) {
      const code: DaemonErrorCode =
        error instanceof DaemonError
          ? error.code
          : error instanceof ConfigError
            ? 'invalid_config'
            : error instanceof SecretStoreUnavailableError
              ? 'unavailable'
              : 'internal';
      this.send({ id: request.id, ok: false, error: { code, message: this.scrub(error) } });
    }
  }

  private async dispatch(method: DaemonMethod, params: unknown): Promise<unknown> {
    switch (method) {
      case 'getStatus':
        return this.status();
      case 'getConfig':
        return this.config;
      case 'saveConfig': {
        const next = validateConfig((params as MethodParamsOf<'saveConfig'>).config);
        await this.writeConfig(next);
        return next;
      }
      case 'setMode':
        return { mode: await this.setMode((params as MethodParamsOf<'setMode'>).mode) };
      case 'resume': {
        const stored = this.db?.getSetting(RESUME_MODE_SETTING);
        return { mode: await this.setMode(stored === 'idle_only' ? 'idle_only' : 'active') };
      }
      case 'setKey': {
        const p = params as MethodParamsOf<'setKey'>;
        await this.setKey(p.provider, p.key);
        return { stored: true };
      }
      case 'deleteKey':
        return { removed: await this.deleteKey((params as MethodParamsOf<'deleteKey'>).provider) };
      case 'probeProvider': {
        const p = params as MethodParamsOf<'probeProvider'>;
        return this.probe(p.id, p.endpoint);
      }
      case 'setIdle':
        this.idle = (params as MethodParamsOf<'setIdle'>).idle;
        this.emitStatus();
        return { idle: this.idle };
      case 'shutdown':
        void this.shutdown();
        return { stopping: true };
    }
  }

  private async writeConfig(next: WorkerConfig): Promise<void> {
    const prev = this.config;
    if (next.schedule.mode === 'paused' && prev.schedule.mode !== 'paused') {
      this.db?.setSetting(RESUME_MODE_SETTING, prev.schedule.mode);
    }
    await writeConfigFile(this.deps.paths.configFile, next);
    const wasConfigured = this.configured;
    this.config = next;
    this.configured = true;
    if (!wasConfigured || needsRestart(prev, next)) void this.enqueue(() => this.restartRunner());
    this.emitStatus();
  }

  private async setMode(mode: ScheduleMode): Promise<ScheduleMode> {
    if (!this.configured) {
      throw new DaemonError('bad_request', 'Finish setting up the worker in Settings first.');
    }
    await this.writeConfig({ ...this.config, schedule: { ...this.config.schedule, mode } });
    return mode;
  }

  private async setKey(provider: string, key: string): Promise<void> {
    if (!this.deps.registry.get(provider)?.requiresKey) {
      throw new DaemonError('bad_request', `Provider "${provider}" does not use an API key`);
    }
    await this.deps.secrets.set(secretAccounts.provider(provider), key);
    this.keys.set(provider, true);
    this.afterKeyChange(provider);
  }

  private async deleteKey(provider: string): Promise<boolean> {
    const removed = await this.deps.secrets.delete(secretAccounts.provider(provider));
    this.keys.set(provider, false);
    this.afterKeyChange(provider);
    return removed;
  }

  private afterKeyChange(provider: string): void {
    if (this.config.providers.some((p) => p.id === provider && p.enabled)) {
      void this.enqueue(() => this.restartRunner());
    }
    this.emitStatus();
  }

  private async probe(id: string, endpoint: string | undefined): Promise<ProbeResult> {
    const registration = this.deps.registry.get(id);
    if (!registration) throw new DaemonError('bad_request', `Unknown provider "${id}"`);
    if (endpoint !== undefined) {
      let url: URL;
      try {
        url = new URL(endpoint);
      } catch {
        throw new DaemonError('bad_request', 'Endpoint must be a valid URL');
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new DaemonError('bad_request', 'Endpoint must use http:// or https://');
      }
    }
    const existing = this.config.providers.find((p) => p.id === id);
    const endpointToUse = endpoint ?? existing?.endpoint;
    const cfg: ProviderConfig = {
      id,
      kind: registration.kind,
      enabled: true,
      models: existing?.models ?? [],
      ...(endpointToUse === undefined ? {} : { endpoint: endpointToUse }),
      ...(existing?.pricing === undefined ? {} : { pricing: existing.pricing }),
    };
    try {
      const provider = await this.deps.registry.create(cfg, this.deps.secrets);
      const health = await provider.healthCheck();
      if (!health.ok) {
        return { ok: false, message: this.scrub(health.message ?? 'Not reachable'), models: [] };
      }
      const models = await provider.getModels();
      return {
        ok: true,
        models: models.map((m) =>
          m.context_window === undefined
            ? { name: m.name }
            : { name: m.name, context_window: m.context_window },
        ),
      };
    } catch (error) {
      return { ok: false, message: this.scrub(error), models: [] };
    }
  }

  private async refreshKeys(): Promise<void> {
    for (const registration of this.deps.registry.list()) {
      if (!registration.requiresKey) continue;
      try {
        const key = await this.deps.secrets.get(secretAccounts.provider(registration.id));
        this.keys.set(registration.id, key !== undefined);
      } catch (error) {
        this.keys.set(registration.id, false);
        this.lastError = this.scrub(error);
      }
    }
  }

  // ---- runner lifecycle (always via enqueue) ----

  private enqueue(op: () => Promise<void>): Promise<void> {
    const next = this.lifecycle.then(op);
    this.lifecycle = next.catch(() => undefined);
    return next;
  }

  private async startRunner(): Promise<void> {
    if (this.stopping || !this.configured || !this.db || this.runner) return;
    clearTimeout(this.retryTimer);
    this.intentionalStop = false;
    const { paths, secrets, registry, logger } = this.deps;
    const runner = new WorkerRunner({
      db: this.db,
      secrets,
      registry,
      logger,
      loadConfig: async () => {
        this.config = await loadConfig(paths.configFile);
        return this.config;
      },
      saveConfig: async (config) => {
        await writeConfigFile(paths.configFile, config);
        this.config = config;
      },
      isIdle: () => this.idle,
      onChange: () => this.emitStatus(),
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      ...this.deps.runnerOverrides,
    });
    this.runner = runner;
    this.lastError = undefined;
    this.emitStatus();
    try {
      await runner.init();
    } catch (error) {
      this.runner = undefined;
      this.lastError = this.scrub(error);
      logger.warn({ err: this.lastError }, 'worker could not start; will retry');
      this.scheduleRetry();
      this.emitStatus();
      return;
    }
    this.runLoop = runner
      .run()
      .catch((error: unknown) => {
        this.lastError = this.scrub(error);
        logger.error({ err: this.lastError }, 'worker loop stopped');
      })
      .finally(() => {
        if (this.runner === runner) {
          this.runner = undefined;
          this.runLoop = undefined;
        }
        if (!this.stopping && !this.intentionalStop) this.scheduleRetry();
        this.emitStatus();
      });
    this.emitStatus();
  }

  private async stopRunner(): Promise<void> {
    clearTimeout(this.retryTimer);
    if (!this.runner) return;
    this.intentionalStop = true;
    this.runner.requestStop();
    await this.runLoop;
  }

  private async restartRunner(): Promise<void> {
    await this.stopRunner();
    await this.startRunner();
  }

  private scheduleRetry(): void {
    if (this.stopping) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(
      () => void this.enqueue(() => this.startRunner()),
      this.deps.restartDelayMs ?? 30_000,
    );
    this.retryTimer.unref();
  }

  // ---- output ----

  private emitStatus(): void {
    if (this.closed) return;
    let data: DaemonStatus;
    try {
      data = this.status();
    } catch (error) {
      this.deps.logger.warn({ err: errorMessage(error) }, 'status unavailable');
      return;
    }
    const event: DaemonEvent = { event: 'status', data };
    this.write(event);
  }

  private send(response: DaemonResponse): void {
    if (!this.closed) this.write(response);
  }

  private write(message: DaemonResponse | DaemonEvent): void {
    this.deps.output.write(`${JSON.stringify(message)}\n`);
  }

  private scrub(error: unknown): string {
    return scrubSecrets(errorMessage(error)).slice(0, 500);
  }
}
```

Add to `apps/worker/src/index.ts`: `export * from './daemon/daemon.js';`

- [ ] **Step 4: Run the daemon tests, then the worker suite, typecheck and lint**

Run: `pnpm --filter @ai-commons/worker exec vitest run test/daemon.test.ts`
Expected: PASS (12 tests).

Run: `pnpm --filter @ai-commons/worker exec vitest run && pnpm --filter @ai-commons/worker typecheck && pnpm lint`
Expected: PASS, clean. If TypeScript reports that `dispatch` doesn't return on all paths, add `throw new DaemonError('unknown_method', method);` after the `switch`.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/worker/src/daemon/daemon.ts apps/worker/src/index.ts apps/worker/test/daemon.test.ts
git commit -m "Add WorkerDaemon: stdio request loop around the worker runner" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Daemon entry point and esbuild bundle

**Files:**

- Create: `apps/worker/src/daemon/entry.ts`, `apps/worker/scripts/bundle-daemon.ts`
- Modify: `apps/worker/package.json` (script and devDependency), `.gitignore`, `.prettierignore`, `eslint.config.js`
- Test: `apps/worker/test/daemon-bundle.test.ts` (new; skipped unless the bundle exists)

- [ ] **Step 1: Write the smoke test**

```ts
// apps/worker/test/daemon-bundle.test.ts
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const bundle = fileURLToPath(new URL('../dist-daemon/worker-daemon.mjs', import.meta.url));

describe.skipIf(!existsSync(bundle))('bundled worker daemon', () => {
  it('answers getStatus over stdio and exits 0 on shutdown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aic-bundle-'));
    try {
      const child = spawn(process.execPath, [bundle], {
        env: { ...process.env, AICOMMONS_CONFIG_DIR: dir, AICOMMONS_DATA_DIR: dir },
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      const messages: Record<string, unknown>[] = [];
      let buffer = '';
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
          messages.push(JSON.parse(buffer.slice(0, i)) as Record<string, unknown>);
          buffer = buffer.slice(i + 1);
        }
      });
      const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));

      child.stdin.write(`${JSON.stringify({ id: 's1', method: 'getStatus' })}\n`);
      const deadline = Date.now() + 15_000;
      while (!messages.some((m) => m.id === 's1')) {
        if (Date.now() > deadline) throw new Error('no response from bundled daemon');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const reply = messages.find((m) => m.id === 's1') as { result: { connection: string } };
      expect(reply.result.connection).toBe('unconfigured');

      child.stdin.write(`${JSON.stringify({ id: 's2', method: 'shutdown' })}\n`);
      expect(await exited).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
```

- [ ] **Step 2: Write the entry point**

```ts
// apps/worker/src/daemon/entry.ts
import { defaultConfig, loadConfig } from '../config.js';
import { createFileAndStderrLogger, scrubSecrets } from '../logger.js';
import { resolvePaths } from '../paths.js';
import { builtinProviders } from '../providers/builtin.js';
import { KeyringSecretStore } from '../secrets.js';
import { WorkerDaemon } from './daemon.js';

// stdout carries protocol lines only; the logger writes to stderr and worker.log.
const paths = resolvePaths();
const level = await loadConfig(paths.configFile).then(
  (config) => config.log_level,
  () => defaultConfig().log_level,
);
const logger = createFileAndStderrLogger(level, paths.logFile);

function fatal(error: unknown): never {
  const text = error instanceof Error ? error.message : String(error);
  logger.fatal({ err: scrubSecrets(text) }, 'worker daemon crashed');
  process.exit(1);
}
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);

const daemon = new WorkerDaemon({
  paths,
  secrets: new KeyringSecretStore(),
  registry: builtinProviders(),
  logger,
  input: process.stdin,
  output: process.stdout,
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void daemon.shutdown());
}
await daemon.start();
await daemon.finished();
process.exit(0);
```

- [ ] **Step 3: Write the bundle script**

```ts
// apps/worker/scripts/bundle-daemon.ts
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));

await build({
  absWorkingDir: root,
  entryPoints: ['src/daemon/entry.ts'],
  outfile: 'dist-daemon/worker-daemon.mjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  // Native addon: the desktop installer ships this package next to the bundle.
  external: ['@napi-rs/keyring'],
  // CommonJS dependencies (pino, sonic-boom) call require(); give the ESM bundle one.
  banner: {
    js: "import { createRequire as __aicCreateRequire } from 'node:module';\nconst require = __aicCreateRequire(import.meta.url);",
  },
  sourcemap: true,
  legalComments: 'external',
  logLevel: 'info',
});
```

In `apps/worker/package.json`, add `"bundle:daemon": "node scripts/bundle-daemon.ts"` to `scripts` and `"devDependencies": { "esbuild": "^0.28.2" }`. Then run `pnpm install`.

- [ ] **Step 4: Ignore generated output**

- Append `dist-daemon/` to `.gitignore` and `.prettierignore`.
- Add `'**/dist-daemon/**'` to the `ignores` array in `eslint.config.js`.

- [ ] **Step 5: Build, bundle and run the smoke test**

```bash
pnpm build
pnpm --filter @ai-commons/worker bundle:daemon
pnpm --filter @ai-commons/worker exec vitest run test/daemon-bundle.test.ts
```

Expected: esbuild reports `dist-daemon/worker-daemon.mjs` (about 1–2 MB), and the smoke test PASSES rather than being skipped.

- If the child dies with `Dynamic require of "…" is not supported`, the banner didn't apply.
- The test reads (never writes) `provider:openai` in the real Windows Credential Manager.

- [ ] **Step 6: Full worker suite, lint, typecheck**

Run: `pnpm --filter @ai-commons/worker exec vitest run && pnpm lint && pnpm typecheck`
Expected: PASS, clean.

- [ ] **Step 7: Commit**

```bash
pnpm format
git add apps/worker/src/daemon/entry.ts apps/worker/scripts/bundle-daemon.ts apps/worker/package.json apps/worker/test/daemon-bundle.test.ts pnpm-lock.yaml .gitignore .prettierignore eslint.config.js
git commit -m "Add worker daemon entry point and esbuild bundle" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Phase B — Desktop UI (`apps/desktop`, TypeScript)

### Task 9: Scaffold `@ai-commons/desktop` (package, DOM helpers, formatting, IPC, styles)

**Files:**

- Create: `apps/desktop/package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `index.html`, `src/dom.ts`, `src/format.ts`, `src/ipc.ts`, `src/styles.css`, `src/env.d.ts`, `test/format.test.ts`, `test/fixtures.ts`

- [ ] **Step 1: Package files**

```json
// apps/desktop/package.json
{
  "name": "@ai-commons/desktop",
  "version": "0.1.0",
  "private": true,
  "description": "AI Commons desktop worker (Tauri shell + web UI).",
  "license": "Apache-2.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "stage": "pnpm --filter @ai-commons/worker bundle:daemon && node scripts/stage-runtime.ts"
  },
  "dependencies": {
    "@tauri-apps/api": "^2"
  },
  "devDependencies": {
    "@ai-commons/worker": "workspace:*",
    "happy-dom": "^20.14.5",
    "vite": "^8.3.1"
  }
}
```

```json
// apps/desktop/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "types": ["vite/client", "node"],
    "noEmit": true
  },
  "include": ["src", "test", "vite.config.ts", "vitest.config.ts"]
}
```

```ts
// apps/desktop/vite.config.ts
import { defineConfig } from 'vite';

export default defineConfig({
  // Tauri loads the built files from disk; relative URLs keep that working.
  base: './',
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { target: 'es2022', sourcemap: true },
});
```

```ts
// apps/desktop/vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'happy-dom' },
});
```

```ts
// apps/desktop/src/env.d.ts
/// <reference types="vite/client" />
```

```html
<!-- apps/desktop/index.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>AI Commons</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="./src/main.ts"></script>
  </body>
</html>
```

Run `pnpm install` from the repo root.

- [ ] **Step 2: DOM helper**

This is the same safe builder as the dashboard's `apps/dashboard/src/dom.ts`: strings become text nodes, and event-handler and `style` attributes are refused. The two apps are independent, so copy the file:

```bash
cp apps/dashboard/src/dom.ts apps/desktop/src/dom.ts
```

- [ ] **Step 3: Write the failing format test**

```ts
// apps/desktop/test/format.test.ts
import { describe, expect, it } from 'vitest';
import { errorText, fmtInt, fmtUsd } from '../src/format.js';

describe('format', () => {
  it('formats money for small and normal amounts', () => {
    expect(fmtUsd(0)).toBe('$0.00');
    expect(fmtUsd(0.14)).toBe('$0.14');
    expect(fmtUsd(0.0042)).toBe('$0.0042');
    expect(fmtUsd(5)).toBe('$5.00');
  });

  it('groups integers', () => {
    expect(fmtInt(318_481)).toBe('318,481');
  });

  it('turns any rejection into readable text', () => {
    expect(errorText(new Error('boom'))).toBe('boom');
    expect(errorText('The worker is not running')).toBe('The worker is not running');
    expect(errorText({})).toBe('Something went wrong.');
  });
});
```

Run: `pnpm --filter @ai-commons/desktop exec vitest run test/format.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 4: Implement `format.ts`**

```ts
// apps/desktop/src/format.ts
export function fmtUsd(n: number): string {
  if (n === 0) return '$0.00';
  return `$${n.toFixed(n < 0.01 ? 4 : 2)}`;
}

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** Tauri rejects `invoke` with the Rust error string; everything else is an Error. */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string' && error.length > 0) return error;
  return 'Something went wrong.';
}
```

- [ ] **Step 5: IPC boundary**

```ts
// apps/desktop/src/ipc.ts
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { DaemonStatus, ProbeResult, ScheduleMode, WorkerConfig } from '@ai-commons/worker';

export interface SupervisorState {
  state: 'running' | 'restarting' | 'stopped';
  message?: string;
}

/** Everything the UI can ask of the shell. Tests pass a fake. */
export interface Backend {
  getStatus(): Promise<DaemonStatus>;
  getConfig(): Promise<WorkerConfig>;
  saveConfig(config: WorkerConfig): Promise<WorkerConfig>;
  setMode(mode: ScheduleMode): Promise<void>;
  resume(): Promise<void>;
  setKey(provider: string, key: string): Promise<void>;
  deleteKey(provider: string): Promise<void>;
  probeProvider(id: string, endpoint?: string): Promise<ProbeResult>;
  restartWorker(): Promise<void>;
  supervisorState(): Promise<SupervisorState>;
  onStatus(callback: (status: DaemonStatus) => void): Promise<() => void>;
  onSupervisor(callback: (state: SupervisorState) => void): Promise<() => void>;
}

function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return invoke<T>('daemon_request', { method, params });
}

export function tauriBackend(): Backend {
  return {
    getStatus: () => call<DaemonStatus>('getStatus'),
    getConfig: () => call<WorkerConfig>('getConfig'),
    saveConfig: (config) => call<WorkerConfig>('saveConfig', { config }),
    setMode: async (mode) => {
      await call('setMode', { mode });
    },
    resume: async () => {
      await call('resume');
    },
    setKey: async (provider, key) => {
      await call('setKey', { provider, key });
    },
    deleteKey: async (provider) => {
      await call('deleteKey', { provider });
    },
    probeProvider: (id, endpoint) =>
      call<ProbeResult>('probeProvider', endpoint === undefined ? { id } : { id, endpoint }),
    restartWorker: () => invoke<void>('restart_worker'),
    supervisorState: () => invoke<SupervisorState>('supervisor_state'),
    onStatus: (callback) => listen<DaemonStatus>('worker-event', (e) => callback(e.payload)),
    onSupervisor: (callback) => listen<SupervisorState>('supervisor', (e) => callback(e.payload)),
  };
}
```

- [ ] **Step 6: Test fixtures (used by Tasks 10–12)**

```ts
// apps/desktop/test/fixtures.ts
import type { DaemonStatus, LocalTotals, WorkerConfig } from '@ai-commons/worker';

const zero: LocalTotals = {
  tasks_submitted: 0,
  tasks_failed: 0,
  input_tokens: 0,
  output_tokens: 0,
  local_inference_ms: 0,
  api_cost_usd: 0,
};

export function status(overrides: Partial<DaemonStatus> = {}): DaemonStatus {
  return {
    connection: 'connected',
    worker_id: 'worker_abc123',
    coordinator_url: 'http://localhost:8080',
    mode: 'active',
    idle: false,
    idle_after_minutes: 5,
    current: {
      project_id: 'open-literature-demo',
      project_name: 'Open Literature Demo',
      task_id: 'task_014238',
    },
    today: {
      ...zero,
      tasks_submitted: 238,
      input_tokens: 300_000,
      output_tokens: 18_481,
      api_cost_usd: 0.14,
    },
    month: { ...zero, tasks_submitted: 1_200, api_cost_usd: 2.1 },
    providers: [
      {
        id: 'ollama',
        kind: 'local',
        display_name: 'Ollama (local)',
        enabled: true,
        healthy: true,
        requires_key: false,
        has_key: false,
      },
      {
        id: 'openai',
        kind: 'remote',
        display_name: 'OpenAI API',
        enabled: false,
        healthy: null,
        requires_key: true,
        has_key: false,
      },
    ],
    limits: { daily_usd: 0.25, monthly_usd: 5 },
    ...overrides,
  };
}

/** A status with no task in progress (exactOptionalPropertyTypes forbids `current: undefined`). */
export function idleStatus(overrides: Partial<DaemonStatus> = {}): DaemonStatus {
  const { current: _current, ...rest } = status(overrides);
  return rest;
}

export function config(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    version: 1,
    coordinator_url: 'http://localhost:8080',
    worker_id: 'worker_abc123',
    providers: [
      {
        id: 'ollama',
        kind: 'local',
        enabled: true,
        endpoint: 'http://localhost:11434',
        models: [{ name: 'qwen3:4b', context_window: 40_960 }],
      },
    ],
    limits: { api: { daily_usd: 0, monthly_usd: 0 }, local: { cpu_percent: 25, gpu_percent: 50 } },
    schedule: { mode: 'active' },
    projects: { categories: 'all', allow_remote_for_projects: [] },
    log_level: 'info',
    ...overrides,
  };
}

export function text(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ');
}

export function $<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`No element matches ${selector}`);
  return el;
}

export const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
```

- [ ] **Step 7: Styles**

```css
/* apps/desktop/src/styles.css */
:root {
  --bg: #f7f8f7;
  --surface: #ffffff;
  --text: #17201d;
  --muted: #5b6763;
  --border: #dde3e0;
  --accent: #0f766e;
  --accent-strong: #0b5c56;
  --track: #e4e9e7;
  --ok: #15803d;
  --ok-weak: #dcf3e3;
  --warn: #a16207;
  --warn-weak: #fbf0d4;
  --danger: #b42318;
  --danger-weak: #fde8e6;
  --neutral-weak: #eceff0;
  --focus: #2563eb;
  --radius: 10px;
  color-scheme: light;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0e1412;
    --surface: #151d1a;
    --text: #e6ece9;
    --muted: #9aa8a3;
    --border: #2a3531;
    --accent: #2dd4bf;
    --accent-strong: #5eead4;
    --track: #25312d;
    --ok: #4ade80;
    --ok-weak: #143322;
    --warn: #fbbf24;
    --warn-weak: #3a2e10;
    --danger: #f87171;
    --danger-weak: #3d1a18;
    --neutral-weak: #242d2a;
    --focus: #93c5fd;
    color-scheme: dark;
  }
}

*,
*::before,
*::after {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font:
    14px/1.5 'Segoe UI Variable',
    'Segoe UI',
    system-ui,
    sans-serif;
  font-variant-numeric: tabular-nums;
}

:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}

.app-header {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}

.app-header h1 {
  margin: 0;
  font-size: 16px;
}

nav[role='tablist'] {
  display: flex;
  gap: 4px;
}

nav[role='tablist'] button {
  border: 0;
  background: transparent;
  color: var(--muted);
  padding: 6px 10px;
  border-radius: 8px;
  font: inherit;
  cursor: pointer;
}

nav[role='tablist'] button[aria-selected='true'] {
  background: var(--neutral-weak);
  color: var(--text);
  font-weight: 600;
}

main {
  display: grid;
  gap: 12px;
  padding: 16px;
}

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 14px;
}

.card h2 {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted);
}

.card h3 {
  margin: 14px 0 6px;
  font-size: 14px;
}

.row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 3px 0;
}

.row .label {
  color: var(--muted);
}

.row .value {
  text-align: right;
  overflow-wrap: anywhere;
}

.muted {
  color: var(--muted);
}

.pill {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 999px;
  font-weight: 600;
}

.pill.ok {
  background: var(--ok-weak);
  color: var(--ok);
}
.pill.warn {
  background: var(--warn-weak);
  color: var(--warn);
}
.pill.danger {
  background: var(--danger-weak);
  color: var(--danger);
}
.pill.neutral {
  background: var(--neutral-weak);
  color: var(--muted);
}

.banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-radius: var(--radius);
  overflow-wrap: anywhere;
}
.banner.warn {
  background: var(--warn-weak);
  color: var(--warn);
}
.banner.danger {
  background: var(--danger-weak);
  color: var(--danger);
}

.meter {
  height: 6px;
  margin: 2px 0 6px;
  border-radius: 999px;
  background: var(--track);
  overflow: hidden;
}
.meter .fill {
  display: block;
  height: 100%;
  background: var(--accent);
}
.meter.warn .fill {
  background: var(--warn);
}

button.primary,
button.secondary {
  font: inherit;
  border-radius: 8px;
  padding: 8px 14px;
  cursor: pointer;
}
button.primary {
  border: 0;
  background: var(--accent);
  color: #fff;
  font-weight: 600;
}
button.secondary {
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
}
button:disabled {
  opacity: 0.6;
  cursor: default;
}
.status-view > button.primary {
  width: 100%;
  padding: 12px;
}

.field {
  display: grid;
  gap: 4px;
  margin: 8px 0;
}
.field > span {
  font-weight: 600;
}
input[type='text'],
input[type='url'],
input[type='number'],
input[type='password'],
input:not([type]),
textarea {
  width: 100%;
  font: inherit;
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px 8px;
}
fieldset {
  border: 0;
  margin: 8px 0;
  padding: 0;
}
legend {
  font-weight: 600;
  padding: 0;
  margin-bottom: 4px;
}
.choice {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
}
.checklist {
  display: grid;
  gap: 2px;
}
.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.form-msg.ok {
  color: var(--ok);
}
.form-msg.warn {
  color: var(--warn);
}
.form-msg.danger {
  color: var(--danger);
}
.save-bar {
  position: sticky;
  bottom: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 0;
  background: var(--bg);
}

dialog.confirm {
  max-width: 360px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text);
}
dialog.confirm::backdrop {
  background: rgb(0 0 0 / 40%);
}
```

- [ ] **Step 8: Run tests and typecheck**

Run: `pnpm build && pnpm --filter @ai-commons/desktop exec vitest run && pnpm --filter @ai-commons/desktop typecheck`
Expected: format tests PASS. Typecheck is clean. It resolves `@ai-commons/worker` types from `apps/worker/dist`, which `pnpm build` produced.

- [ ] **Step 9: Commit**

```bash
pnpm format
git add apps/desktop pnpm-lock.yaml
git commit -m "Scaffold desktop UI package with formatting, IPC and styles" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Status view (§35)

**Files:**

- Create: `apps/desktop/src/status-view.ts`
- Test: `apps/desktop/test/status-view.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/desktop/test/status-view.test.ts
import { describe, expect, it } from 'vitest';
import { connectionLabel, renderStatus } from '../src/status-view.js';
import { $, idleStatus, status, text } from './fixtures.js';

const running = { state: 'running' } as const;
const noop = { onTogglePause: () => undefined, onRestart: () => undefined };

describe('renderStatus', () => {
  it('shows the §35 screen', () => {
    const t = text(renderStatus(status(), running, noop));
    expect(t).toContain('Connected');
    expect(t).toContain('Current projectOpen Literature Demo');
    expect(t).toContain('Current task#task_014238');
    expect(t).toContain('Tasks238');
    expect(t).toContain('Tokens318,481');
    expect(t).toContain('API cost$0.14');
    expect(t).toContain('This month: 1,200 tasks · $2.10');
    expect(t).toContain('Ollama (local)Enabled');
    expect(t).toContain('OpenAI APIDisabled');
    expect(t).toContain('Daily API limit$0.14 / $0.25');
    expect(t).toContain('Monthly API limit$2.10 / $5.00');
    expect(t).toContain('Pause contributions');
  });

  it('shows dashes when no task is running', () => {
    const t = text(renderStatus(idleStatus(), running, noop));
    expect(t).toContain('Current project—');
    expect(t).toContain('Current task—');
  });

  it('turns the spend meter amber at 80% of the limit', () => {
    const el = renderStatus(
      status({ today: { ...status().today, api_cost_usd: 0.21 } }),
      running,
      noop,
    );
    const daily = $(el, '[role="meter"][aria-label="Daily API limit"]');
    expect(daily.classList.contains('warn')).toBe(true);
    expect(daily.getAttribute('aria-valuenow')).toBe('84');
  });

  it('explains a $0 limit instead of drawing a meter', () => {
    const t = text(
      renderStatus(status({ limits: { daily_usd: 0, monthly_usd: 0 } }), running, noop),
    );
    expect(t).toContain('No paid calls ($0 limit)');
  });

  it('flags enabled providers that are unavailable or missing a key', () => {
    const providers = status().providers.map((p) =>
      p.id === 'openai' ? { ...p, enabled: true } : { ...p, healthy: false },
    );
    const t = text(renderStatus(status({ providers }), running, noop));
    expect(t).toContain('Ollama (local)Enabled · unavailable');
    expect(t).toContain('OpenAI APIEnabled · no API key');
  });

  it('shows offline errors as text, never HTML', () => {
    const el = renderStatus(
      status({ connection: 'offline', last_error: '<img src=x onerror=alert(1)>' }),
      running,
      noop,
    );
    expect(text(el)).toContain('Offline');
    expect(text(el)).toContain('<img src=x onerror=alert(1)>');
    expect(el.querySelector('img')).toBeNull();
  });

  it('offers Resume when paused', () => {
    const el = renderStatus(status({ mode: 'paused' }), running, noop);
    expect(text(el)).toContain('Paused');
    expect($(el, '[data-action="toggle-pause"]').textContent).toBe('Resume contributions');
  });

  it('calls the handlers', () => {
    let toggled = 0;
    let restarted = 0;
    const el = renderStatus(
      status(),
      { state: 'stopped', message: 'exit code 1' },
      { onTogglePause: () => toggled++, onRestart: () => restarted++ },
    );
    expect(text(el)).toContain('Worker stopped: exit code 1');
    $(el, '[data-action="toggle-pause"]').click();
    $(el, '[data-action="restart"]').click();
    expect([toggled, restarted]).toEqual([1, 1]);
  });

  it('shows an action error passed by the app', () => {
    expect(text(renderStatus(status(), running, noop, 'The worker is not running'))).toContain(
      'The worker is not running',
    );
  });
});

describe('connectionLabel', () => {
  it('covers every state', () => {
    expect(connectionLabel(status({ connection: 'unconfigured' })).text).toBe('Not set up');
    expect(connectionLabel(status({ connection: 'connecting' })).text).toBe('Connecting…');
    expect(connectionLabel(status({ mode: 'idle_only', idle: false })).text).toBe(
      'Waiting for idle',
    );
    expect(connectionLabel(status({ mode: 'idle_only', idle: true })).text).toBe('Connected');
  });
});
```

Run: `pnpm --filter @ai-commons/desktop exec vitest run test/status-view.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 2: Implement**

```ts
// apps/desktop/src/status-view.ts
import type { DaemonStatus, ProviderStatus } from '@ai-commons/worker';
import { h, type Child } from './dom.js';
import { fmtInt, fmtUsd } from './format.js';
import type { SupervisorState } from './ipc.js';

export type Tone = 'ok' | 'warn' | 'danger' | 'neutral';

export interface StatusActions {
  onTogglePause: () => void;
  onRestart: () => void;
}

export function connectionLabel(s: DaemonStatus): { text: string; tone: Tone } {
  if (s.connection === 'unconfigured') return { text: 'Not set up', tone: 'neutral' };
  if (s.connection === 'offline') return { text: 'Offline', tone: 'danger' };
  if (s.connection === 'connecting') return { text: 'Connecting…', tone: 'warn' };
  if (s.mode === 'paused') return { text: 'Paused', tone: 'neutral' };
  if (s.mode === 'idle_only' && !s.idle) return { text: 'Waiting for idle', tone: 'neutral' };
  return { text: 'Connected', tone: 'ok' };
}

function row(label: string, value: Child): HTMLElement {
  return h(
    'div',
    { class: 'row' },
    h('span', { class: 'label' }, label),
    h('span', { class: 'value' }, value),
  );
}

function button(
  label: string,
  action: string,
  onClick: () => void,
  cls = 'secondary',
): HTMLButtonElement {
  const el = h('button', { type: 'button', class: cls, 'data-action': action }, label);
  el.addEventListener('click', onClick);
  return el;
}

function meter(label: string, spent: number, limit: number): HTMLElement {
  if (limit <= 0) return row(label, 'No paid calls ($0 limit)');
  const pct = Math.min(100, (spent / limit) * 100);
  const fill = h('span', { class: 'fill' });
  fill.style.width = `${pct}%`;
  const bar = h(
    'div',
    {
      class: pct >= 80 ? 'meter warn' : 'meter',
      role: 'meter',
      'aria-label': label,
      'aria-valuemin': 0,
      'aria-valuemax': 100,
      'aria-valuenow': Math.round(pct),
    },
    fill,
  );
  return h('div', {}, row(label, `${fmtUsd(spent)} / ${fmtUsd(limit)}`), bar);
}

function providerState(p: ProviderStatus): string {
  if (!p.enabled) return 'Disabled';
  if (p.requires_key && !p.has_key) return 'Enabled · no API key';
  if (p.healthy === false) return 'Enabled · unavailable';
  return 'Enabled';
}

function banner(s: DaemonStatus, sup: SupervisorState, actions: StatusActions): HTMLElement | null {
  if (sup.state === 'restarting') {
    return h(
      'div',
      { class: 'banner warn', role: 'status' },
      sup.message ?? 'Restarting the worker…',
    );
  }
  if (sup.state === 'stopped') {
    return h(
      'div',
      { class: 'banner danger', role: 'alert' },
      h('span', {}, `Worker stopped: ${sup.message ?? 'unknown error'}`),
      button('Restart', 'restart', actions.onRestart),
    );
  }
  if (s.last_error) return h('div', { class: 'banner warn', role: 'status' }, s.last_error);
  return null;
}

export function renderStatus(
  s: DaemonStatus,
  sup: SupervisorState,
  actions: StatusActions,
  notice?: string,
): HTMLElement {
  const conn = connectionLabel(s);
  const current = s.current;
  return h(
    'div',
    { class: 'status-view' },
    banner(s, sup, actions),
    notice ? h('div', { class: 'banner danger', role: 'alert' }, notice) : null,
    h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Status'),
      h('p', {}, h('span', { class: `pill ${conn.tone}`, 'data-live': 'connection' }, conn.text)),
      row('Current project', current ? (current.project_name ?? current.project_id) : '—'),
      row('Current task', current ? `#${current.task_id}` : '—'),
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Contribution today'),
      row('Tasks', fmtInt(s.today.tasks_submitted)),
      row('Tokens', fmtInt(s.today.input_tokens + s.today.output_tokens)),
      row('API cost', fmtUsd(s.today.api_cost_usd)),
      h(
        'p',
        { class: 'muted' },
        `This month: ${fmtInt(s.month.tasks_submitted)} tasks · ${fmtUsd(s.month.api_cost_usd)}`,
      ),
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Resources'),
      ...s.providers.map((p) => row(p.display_name, providerState(p))),
      meter('Daily API limit', s.today.api_cost_usd, s.limits.daily_usd),
      meter('Monthly API limit', s.month.api_cost_usd, s.limits.monthly_usd),
    ),
    button(
      s.mode === 'paused' ? 'Resume contributions' : 'Pause contributions',
      'toggle-pause',
      actions.onTogglePause,
      'primary',
    ),
  );
}
```

- [ ] **Step 3: Run the tests**

Run: `pnpm --filter @ai-commons/desktop exec vitest run test/status-view.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
pnpm format
git add apps/desktop/src/status-view.ts apps/desktop/test/status-view.test.ts
git commit -m "Add desktop status view" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Settings view (§36)

**Files:**

- Create: `apps/desktop/src/settings-view.ts`
- Test: `apps/desktop/test/settings-view.test.ts`

Field names read by `readSettingsForm`:

| Field                                                                         | Maps to                                           |
| ----------------------------------------------------------------------------- | ------------------------------------------------- |
| `coordinator_url`                                                             | `coordinator_url`                                 |
| `ollama.enabled`, `ollama.endpoint`, `ollama.model` (checkboxes)              | provider `ollama`                                 |
| `openai.enabled`, `openai.model`, `openai.input_price`, `openai.output_price` | provider `openai` (`pricing`)                     |
| `remote_scope` (`all`/`list`), `remote_projects`                              | `projects.allow_remote_for_projects`              |
| `daily_usd`, `monthly_usd`                                                    | `limits.api`                                      |
| `mode`, `idle_after_minutes`                                                  | `schedule`                                        |
| `categories_scope` (`all`/`selected`), `category` (checkboxes)                | `projects.categories`                             |
| `openai.key`                                                                  | never read into config; sent only with `onSetKey` |

- [ ] **Step 1: Write the failing tests**

```ts
// apps/desktop/test/settings-view.test.ts
import type { WorkerConfig } from '@ai-commons/worker';
import { beforeEach, describe, expect, it } from 'vitest';
import { readSettingsForm, renderSettings, type SettingsHandlers } from '../src/settings-view.js';
import { $, config, flush, status } from './fixtures.js';

const KEY = 'sk-test-UIKEY1234567890abcdef';

function setValue(form: HTMLFormElement, name: string, value: string): void {
  $<HTMLInputElement>(form, `[name="${name}"]`).value = value;
}

function setChecked(form: HTMLFormElement, name: string, checked: boolean): void {
  $<HTMLInputElement>(form, `input[name="${name}"]`).checked = checked;
}

/** Explicitly clears the group so the test does not depend on radio-group support. */
function choose(form: HTMLFormElement, name: string, value: string): void {
  for (const el of form.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)) {
    el.checked = el.value === value;
  }
}

function mount(cfg: WorkerConfig = config(), overrides: Partial<SettingsHandlers> = {}) {
  const saved: WorkerConfig[] = [];
  const keys: [string, string][] = [];
  const confirms: string[] = [];
  const handlers: SettingsHandlers = {
    onSave: async (c) => {
      saved.push(c);
    },
    onProbe: async () => ({
      ok: true,
      models: [
        { name: 'qwen3:4b', context_window: 40_960 },
        { name: 'llama3.2:3b', context_window: 131_072 },
      ],
    }),
    onSetKey: async (provider, key) => {
      keys.push([provider, key]);
    },
    onDeleteKey: async () => undefined,
    confirm: async (message) => {
      confirms.push(message);
      return true;
    },
    disclosure: 'DISCLOSURE',
    ...overrides,
  };
  const form = renderSettings(cfg, status(), handlers);
  document.body.replaceChildren(form);
  return { form, saved, keys, confirms };
}

function submit(form: HTMLFormElement): void {
  form.dispatchEvent(new Event('submit', { cancelable: true }));
}

function enableOpenAI(form: HTMLFormElement): void {
  setChecked(form, 'openai.enabled', true);
  setValue(form, 'openai.model', 'gpt-4o-mini');
  setValue(form, 'openai.input_price', '0.15');
  setValue(form, 'openai.output_price', '0.6');
}

beforeEach(() => document.body.replaceChildren());

describe('readSettingsForm', () => {
  it('round-trips an unchanged form', () => {
    const cfg = config();
    const { form } = mount(cfg);
    expect(readSettingsForm(form, cfg)).toEqual({
      ok: true,
      config: { ...cfg, schedule: { mode: 'active', idle_after_minutes: 5 } },
    });
  });

  it('reads limits, schedule, and categories', () => {
    const { form } = mount();
    setValue(form, 'daily_usd', '0.25');
    setValue(form, 'monthly_usd', '5');
    choose(form, 'mode', 'idle_only');
    setValue(form, 'idle_after_minutes', '10');
    choose(form, 'categories_scope', 'selected');
    for (const el of form.querySelectorAll<HTMLInputElement>('input[name="category"]')) {
      el.checked = el.value === 'science' || el.value === 'climate';
    }
    const result = readSettingsForm(form, config());
    if (!result.ok) throw new Error(result.error);
    expect(result.config.limits.api).toEqual({ daily_usd: 0.25, monthly_usd: 5 });
    expect(result.config.schedule).toEqual({ mode: 'idle_only', idle_after_minutes: 10 });
    expect(result.config.projects.categories).toEqual(['science', 'climate']);
  });

  it('rejects a daily limit above the monthly limit', () => {
    const { form } = mount();
    setValue(form, 'daily_usd', '2');
    setValue(form, 'monthly_usd', '1');
    expect(readSettingsForm(form, config())).toMatchObject({ ok: false });
  });

  it('requires a model and prices for an enabled OpenAI provider', () => {
    const { form } = mount();
    setChecked(form, 'openai.enabled', true);
    expect(readSettingsForm(form, config())).toMatchObject({
      ok: false,
      error: expect.stringMatching(/model and its prices/),
    });
    enableOpenAI(form);
    choose(form, 'remote_scope', 'list');
    setValue(form, 'remote_projects', 'open-literature-demo, climate-notes');
    const result = readSettingsForm(form, config());
    if (!result.ok) throw new Error(result.error);
    expect(result.config.providers.find((p) => p.id === 'openai')).toEqual({
      id: 'openai',
      kind: 'remote',
      enabled: true,
      models: [{ name: 'gpt-4o-mini' }],
      pricing: { 'gpt-4o-mini': { input_per_mtok: 0.15, output_per_mtok: 0.6 } },
    });
    expect(result.config.projects.allow_remote_for_projects).toEqual([
      'open-literature-demo',
      'climate-notes',
    ]);
  });
});

describe('renderSettings', () => {
  it('adds detected models with their context windows', async () => {
    const { form } = mount();
    $(form, '[data-action="detect"]').click();
    await flush();
    await flush();
    const boxes = [...form.querySelectorAll<HTMLInputElement>('input[name="ollama.model"]')];
    expect(boxes.map((b) => [b.value, b.checked, b.dataset.contextWindow])).toEqual([
      ['qwen3:4b', true, '40960'],
      ['llama3.2:3b', false, '131072'],
    ]);
  });

  it('asks before enabling a remote provider and does not save if declined', async () => {
    const { form, saved, confirms } = mount(config(), { confirm: async () => false });
    enableOpenAI(form);
    submit(form);
    await flush();
    expect(saved).toHaveLength(0);
    expect(confirms).toHaveLength(0); // the override replaced the recorder
    expect($(form, '.form-msg').textContent).toMatch(/Not saved/);
  });

  it('saves after the disclosure is accepted', async () => {
    const { form, saved, confirms } = mount();
    enableOpenAI(form);
    submit(form);
    await flush();
    expect(confirms).toEqual(['DISCLOSURE']);
    expect(saved).toHaveLength(1);
    expect($(form, '.form-msg').textContent).toBe('Settings saved.');
  });

  it('sends the API key only through onSetKey and clears the field', async () => {
    const { form, keys, saved } = mount();
    const input = $<HTMLInputElement>(form, 'input[name="openai.key"]');
    input.value = KEY;
    $(form, '[data-action="save-key"]').click();
    expect(input.value).toBe('');
    await flush();
    expect(keys).toEqual([['openai', KEY]]);
    expect($(form, '[data-live="key-state"]').textContent).toBe('Key stored ✓');

    submit(form);
    await flush();
    expect(JSON.stringify(saved)).not.toContain(KEY);
  });
});
```

Run: `pnpm --filter @ai-commons/desktop exec vitest run test/settings-view.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 2: Implement**

```ts
// apps/desktop/src/settings-view.ts
import type { DaemonStatus, ProbeResult, ProviderConfig, WorkerConfig } from '@ai-commons/worker';
import { h, type Attrs } from './dom.js';
import { errorText, fmtInt } from './format.js';
import { connectionLabel } from './status-view.js';

const OLLAMA_DEFAULT = 'http://localhost:11434';
const DEFAULT_IDLE_MINUTES = 5;

export const CATEGORIES = [
  ['science', 'Science'],
  ['medicine', 'Medicine'],
  ['astronomy', 'Astronomy'],
  ['climate', 'Climate'],
  ['open_source', 'Open source'],
  ['history', 'History'],
  ['education', 'Education'],
] as const;
type Category = (typeof CATEGORIES)[number][0];

export interface SettingsHandlers {
  onSave: (config: WorkerConfig) => Promise<void>;
  onProbe: (id: string, endpoint: string) => Promise<ProbeResult>;
  onSetKey: (provider: string, key: string) => Promise<void>;
  onDeleteKey: (provider: string) => Promise<void>;
  confirm: (message: string) => Promise<boolean>;
  /** REMOTE_DISCLOSURE, shown before any remote provider is enabled. */
  disclosure: string;
}

export type FormResult = { ok: true; config: WorkerConfig } | { ok: false; error: string };
type Model = { name: string; context_window?: number };
type Tone = 'ok' | 'warn' | 'danger' | 'neutral';

// ---- reading ----

function field(form: HTMLFormElement, name: string): HTMLInputElement | HTMLTextAreaElement {
  const el = form.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`);
  if (!el) throw new Error(`Missing form field ${name}`);
  return el;
}

function checked(form: HTMLFormElement, name: string): boolean {
  return form.querySelector<HTMLInputElement>(`input[name="${name}"]`)?.checked ?? false;
}

function radio(form: HTMLFormElement, name: string): string {
  return form.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value ?? '';
}

function checkedBoxes(form: HTMLFormElement, name: string): HTMLInputElement[] {
  return [...form.querySelectorAll<HTMLInputElement>(`input[name="${name}"]:checked`)];
}

function isCategory(value: string): value is Category {
  return CATEGORIES.some(([c]) => c === value);
}

/** Pure DOM → WorkerConfig. The daemon validates again; this gives friendlier messages. */
export function readSettingsForm(form: HTMLFormElement, base: WorkerConfig): FormResult {
  const coordinator = field(form, 'coordinator_url').value.trim();
  if (!coordinator) return { ok: false, error: 'Enter the coordinator URL.' };

  const daily = Number(field(form, 'daily_usd').value);
  const monthly = Number(field(form, 'monthly_usd').value);
  if (!Number.isFinite(daily) || daily < 0 || !Number.isFinite(monthly) || monthly < 0) {
    return { ok: false, error: 'API limits must be zero or positive numbers.' };
  }
  if (daily > monthly) {
    return { ok: false, error: 'The daily API limit cannot exceed the monthly limit.' };
  }

  const mode = radio(form, 'mode');
  if (mode !== 'active' && mode !== 'idle_only' && mode !== 'paused') {
    return { ok: false, error: 'Choose a schedule.' };
  }
  const idleAfter = Number(field(form, 'idle_after_minutes').value);
  if (!Number.isInteger(idleAfter) || idleAfter < 1 || idleAfter > 240) {
    return { ok: false, error: 'Idle time must be a whole number of minutes from 1 to 240.' };
  }

  let categories: WorkerConfig['projects']['categories'] = 'all';
  if (radio(form, 'categories_scope') === 'selected') {
    const picked = checkedBoxes(form, 'category')
      .map((el) => el.value)
      .filter(isCategory);
    if (picked.length === 0) return { ok: false, error: 'Pick at least one project category.' };
    categories = picked;
  }

  let allowRemote: WorkerConfig['projects']['allow_remote_for_projects'] = 'all';
  if (radio(form, 'remote_scope') !== 'all') {
    allowRemote = field(form, 'remote_projects')
      .value.split(/[\s,]+/)
      .filter((id) => id.length > 0);
  }

  const ollamaBase = base.providers.find((p) => p.id === 'ollama');
  const ollama: ProviderConfig = {
    ...ollamaBase,
    id: 'ollama',
    kind: 'local',
    enabled: checked(form, 'ollama.enabled'),
    endpoint: field(form, 'ollama.endpoint').value.trim() || OLLAMA_DEFAULT,
    models: checkedBoxes(form, 'ollama.model').map((el) => {
      const cw = Number(el.dataset.contextWindow);
      return Number.isInteger(cw) && cw > 0
        ? { name: el.value, context_window: cw }
        : { name: el.value };
    }),
  };

  const openaiBase = base.providers.find((p) => p.id === 'openai');
  const openaiEnabled = checked(form, 'openai.enabled');
  const model = field(form, 'openai.model').value.trim();
  const inPrice = field(form, 'openai.input_price').value.trim();
  const outPrice = field(form, 'openai.output_price').value.trim();
  let openai: ProviderConfig | undefined;
  if (openaiEnabled || model || openaiBase) {
    const priced = model !== '' && inPrice !== '' && outPrice !== '';
    if (openaiEnabled && !priced) {
      return {
        ok: false,
        error: 'OpenAI needs a model and its prices per 1M input and output tokens.',
      };
    }
    const input = Number(inPrice);
    const output = Number(outPrice);
    if (priced && (!(input >= 0) || !(output >= 0))) {
      return { ok: false, error: 'Prices must be zero or positive numbers.' };
    }
    openai = {
      id: 'openai',
      kind: 'remote',
      enabled: openaiEnabled,
      models: model ? [{ name: model }] : [],
      ...(openaiBase?.endpoint === undefined ? {} : { endpoint: openaiBase.endpoint }),
      ...(priced
        ? { pricing: { [model]: { input_per_mtok: input, output_per_mtok: output } } }
        : {}),
    };
  }

  const others = base.providers.filter((p) => p.id !== 'ollama' && p.id !== 'openai');
  return {
    ok: true,
    config: {
      ...base,
      coordinator_url: coordinator,
      providers: [ollama, ...(openai ? [openai] : []), ...others],
      limits: { ...base.limits, api: { daily_usd: daily, monthly_usd: monthly } },
      schedule: { mode, idle_after_minutes: idleAfter },
      projects: { categories, allow_remote_for_projects: allowRemote },
    },
  };
}

// ---- rendering ----

function input(name: string, value: string, attrs: Attrs = {}): HTMLInputElement {
  return h('input', { name, value, spellcheck: 'false', ...attrs });
}

function labeled(text: string, control: HTMLElement): HTMLElement {
  return h('label', { class: 'field' }, h('span', {}, text), control);
}

function choice(
  type: 'radio' | 'checkbox',
  name: string,
  value: string,
  label: string,
  on: boolean,
): HTMLElement {
  return h('label', { class: 'choice' }, h('input', { type, name, value, checked: on }), label);
}

function row(label: string, value: HTMLElement | string): HTMLElement {
  return h(
    'div',
    { class: 'row' },
    h('span', { class: 'label' }, label),
    h('span', { class: 'value' }, value),
  );
}

function actionButton(label: string, action: string, cls = 'secondary'): HTMLButtonElement {
  return h('button', { type: 'button', class: cls, 'data-action': action }, label);
}

function setMsg(el: HTMLElement, text: string, tone: Tone = 'neutral'): void {
  el.textContent = text;
  el.className = `form-msg ${tone}`;
}

function modelList(models: Model[], selected: ReadonlySet<string>): HTMLElement {
  if (models.length === 0) {
    return h(
      'p',
      { class: 'muted', 'data-section': 'ollama-models' },
      'No models yet. Click "Detect models".',
    );
  }
  return h(
    'div',
    { class: 'checklist', 'data-section': 'ollama-models' },
    ...models.map((m) =>
      h(
        'label',
        { class: 'choice' },
        h('input', {
          type: 'checkbox',
          name: 'ollama.model',
          value: m.name,
          checked: selected.has(m.name),
          'data-context-window': m.context_window,
        }),
        m.context_window ? `${m.name} (${fmtInt(m.context_window)} tokens)` : m.name,
      ),
    ),
  );
}

export function renderSettings(
  initial: WorkerConfig,
  status: DaemonStatus | undefined,
  handlers: SettingsHandlers,
): HTMLFormElement {
  let current = initial;
  const ollama = initial.providers.find((p) => p.id === 'ollama');
  const openai = initial.providers.find((p) => p.id === 'openai');
  const openaiModel = openai?.models[0]?.name ?? '';
  const price = openaiModel ? openai?.pricing?.[openaiModel] : undefined;
  const allowRemote = initial.projects.allow_remote_for_projects;
  const cats = initial.projects.categories;
  const mode = initial.schedule.mode;
  const hasKey = status?.providers.find((p) => p.id === 'openai')?.has_key ?? false;

  const probeMsg = h('span', { class: 'form-msg neutral', role: 'status' });
  const keyMsg = h('span', { class: 'form-msg neutral', role: 'status' });
  const formMsg = h('span', { class: 'form-msg neutral', role: 'status' });
  const detect = actionButton('Detect models', 'detect');
  const keyState = h(
    'span',
    { class: 'muted', 'data-live': 'key-state' },
    hasKey ? 'Key stored ✓' : 'No key stored',
  );
  const keyInput = h('input', {
    type: 'password',
    name: 'openai.key',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: hasKey ? 'Paste a new key to replace it' : 'sk-…',
  });
  const saveKey = actionButton('Save key', 'save-key');
  const removeKey = actionButton('Remove key', 'remove-key');
  const submitButton = h('button', { type: 'submit', class: 'primary' }, 'Save settings');

  const form = h(
    'form',
    { class: 'settings', novalidate: true },
    h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Coordinator'),
      labeled(
        'Coordinator URL',
        input('coordinator_url', initial.coordinator_url, { type: 'url' }),
      ),
      row(
        'Connection',
        h('span', { 'data-live': 'connection' }, status ? connectionLabel(status).text : 'Unknown'),
      ),
      row(
        'Worker ID',
        h('code', {}, status?.worker_id ?? initial.worker_id ?? 'Not registered yet'),
      ),
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Providers'),
      h('h3', {}, 'Ollama (local)'),
      choice(
        'checkbox',
        'ollama.enabled',
        'on',
        'Use Ollama on this computer',
        ollama?.enabled ?? false,
      ),
      labeled('Endpoint', input('ollama.endpoint', ollama?.endpoint ?? OLLAMA_DEFAULT)),
      h('div', { class: 'actions' }, detect, probeMsg),
      modelList(ollama?.models ?? [], new Set(ollama?.models.map((m) => m.name))),
      h('h3', {}, 'OpenAI (paid API)'),
      choice('checkbox', 'openai.enabled', 'on', 'Use my OpenAI API key', openai?.enabled ?? false),
      h(
        'div',
        { class: 'field' },
        h('span', {}, 'API key'),
        keyState,
        keyInput,
        h('div', { class: 'actions' }, saveKey, removeKey, keyMsg),
        h(
          'small',
          { class: 'muted' },
          'Stored in Windows Credential Manager. Never sent to the coordinator.',
        ),
      ),
      labeled('Model', input('openai.model', openaiModel, { placeholder: 'e.g. gpt-4o-mini' })),
      h(
        'div',
        { class: 'grid-2' },
        labeled(
          'Input $ / 1M tokens',
          input('openai.input_price', price ? String(price.input_per_mtok) : '', {
            type: 'number',
            min: 0,
            step: 'any',
          }),
        ),
        labeled(
          'Output $ / 1M tokens',
          input('openai.output_price', price ? String(price.output_per_mtok) : '', {
            type: 'number',
            min: 0,
            step: 'any',
          }),
        ),
      ),
      h(
        'fieldset',
        {},
        h('legend', {}, 'Projects allowed to use paid APIs'),
        choice('radio', 'remote_scope', 'all', 'All approved projects', allowRemote === 'all'),
        choice('radio', 'remote_scope', 'list', 'Only these project IDs', allowRemote !== 'all'),
        h(
          'textarea',
          { name: 'remote_projects', rows: 2, spellcheck: 'false' },
          allowRemote === 'all' ? '' : allowRemote.join(', '),
        ),
      ),
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Limits'),
      h(
        'div',
        { class: 'grid-2' },
        labeled(
          'Daily API limit (USD)',
          input('daily_usd', String(initial.limits.api.daily_usd), {
            type: 'number',
            min: 0,
            step: '0.01',
          }),
        ),
        labeled(
          'Monthly API limit (USD)',
          input('monthly_usd', String(initial.limits.api.monthly_usd), {
            type: 'number',
            min: 0,
            step: '0.01',
          }),
        ),
      ),
      h(
        'p',
        { class: 'muted' },
        '$0 means no paid API calls. Limits are enforced on this computer, never by the coordinator.',
      ),
      h(
        'div',
        { class: 'grid-2' },
        labeled(
          'CPU limit (%)',
          input('cpu_percent', String(initial.limits.local.cpu_percent), {
            type: 'number',
            disabled: true,
          }),
        ),
        labeled(
          'GPU preference (%)',
          input('gpu_percent', String(initial.limits.local.gpu_percent), {
            type: 'number',
            disabled: true,
          }),
        ),
      ),
      h('p', { class: 'muted' }, 'CPU and GPU limits are recorded but not yet enforced.'),
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Schedule'),
      choice('radio', 'mode', 'active', 'Always', mode === 'active'),
      choice(
        'radio',
        'mode',
        'idle_only',
        'Only while this computer is idle',
        mode === 'idle_only',
      ),
      choice('radio', 'mode', 'paused', 'Paused', mode === 'paused'),
      labeled(
        'Idle after (minutes without keyboard or mouse input)',
        input(
          'idle_after_minutes',
          String(initial.schedule.idle_after_minutes ?? DEFAULT_IDLE_MINUTES),
          { type: 'number', min: 1, max: 240, step: 1 },
        ),
      ),
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Projects'),
      choice('radio', 'categories_scope', 'all', 'All approved projects', cats === 'all'),
      choice('radio', 'categories_scope', 'selected', 'Selected categories', cats !== 'all'),
      h(
        'div',
        { class: 'checklist' },
        ...CATEGORIES.map(([value, label]) =>
          choice('checkbox', 'category', value, label, cats !== 'all' && cats.includes(value)),
        ),
      ),
    ),
    h('div', { class: 'save-bar' }, submitButton, formMsg),
  );

  detect.addEventListener('click', () => {
    void (async () => {
      detect.disabled = true;
      setMsg(probeMsg, 'Checking…');
      try {
        const endpoint = field(form, 'ollama.endpoint').value.trim() || OLLAMA_DEFAULT;
        const result = await handlers.onProbe('ollama', endpoint);
        if (!result.ok) {
          setMsg(probeMsg, result.message ?? 'Ollama is not reachable.', 'danger');
          return;
        }
        const selected = new Set(checkedBoxes(form, 'ollama.model').map((el) => el.value));
        const known = [...form.querySelectorAll<HTMLInputElement>('input[name="ollama.model"]')]
          .filter((el) => !result.models.some((m) => m.name === el.value))
          .map((el) => ({ name: el.value }));
        form
          .querySelector('[data-section="ollama-models"]')
          ?.replaceWith(modelList([...result.models, ...known], selected));
        setMsg(probeMsg, `Found ${result.models.length} model(s).`, 'ok');
      } catch (error) {
        setMsg(probeMsg, errorText(error), 'danger');
      } finally {
        detect.disabled = false;
      }
    })();
  });

  const submitKey = async () => {
    const key = keyInput.value.trim();
    keyInput.value = ''; // never leave a key sitting in the DOM
    if (!key) {
      setMsg(keyMsg, 'Paste a key first.', 'warn');
      return;
    }
    try {
      await handlers.onSetKey('openai', key);
      keyState.textContent = 'Key stored ✓';
      setMsg(keyMsg, 'Key saved.', 'ok');
    } catch (error) {
      setMsg(keyMsg, errorText(error), 'danger');
    }
  };
  saveKey.addEventListener('click', () => void submitKey());
  keyInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault(); // Enter here saves the key, not the whole form
    void submitKey();
  });
  removeKey.addEventListener('click', () => {
    void (async () => {
      try {
        await handlers.onDeleteKey('openai');
        keyState.textContent = 'No key stored';
        setMsg(keyMsg, 'Key removed.', 'ok');
      } catch (error) {
        setMsg(keyMsg, errorText(error), 'danger');
      }
    })();
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void (async () => {
      const result = readSettingsForm(form, current);
      if (!result.ok) {
        setMsg(formMsg, result.error, 'danger');
        return;
      }
      const wasRemote = current.providers.some((p) => p.kind === 'remote' && p.enabled);
      const nowRemote = result.config.providers.some((p) => p.kind === 'remote' && p.enabled);
      if (nowRemote && !wasRemote && !(await handlers.confirm(handlers.disclosure))) {
        setMsg(formMsg, 'Not saved: the paid provider was not confirmed.', 'warn');
        return;
      }
      submitButton.disabled = true;
      try {
        await handlers.onSave(result.config);
        current = result.config;
        setMsg(formMsg, 'Settings saved.', 'ok');
      } catch (error) {
        setMsg(formMsg, errorText(error), 'danger');
      } finally {
        submitButton.disabled = false;
      }
    })();
  });

  return form;
}
```

- [ ] **Step 3: Run the tests**

Run: `pnpm --filter @ai-commons/desktop exec vitest run test/settings-view.test.ts`
Expected: PASS.

In the "declined" test, `confirms` stays empty because the override replaces the recording `confirm`. That's intentional; the test asserts on `saved` and the message.

If happy-dom doesn't populate `el.dataset` from `data-*` attributes, change the check to `el.getAttribute('data-context-window')` in both `readSettingsForm` and the test.

- [ ] **Step 4: Commit**

```bash
pnpm format
git add apps/desktop/src/settings-view.ts apps/desktop/test/settings-view.test.ts
git commit -m "Add desktop settings view" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: App shell, confirmation dialog, entry point

**Files:**

- Create: `apps/desktop/src/app.ts`, `apps/desktop/src/dialog.ts`, `apps/desktop/src/main.ts`
- Test: `apps/desktop/test/app.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/desktop/test/app.test.ts
import type { DaemonStatus } from '@ai-commons/worker';
import { describe, expect, it } from 'vitest';
import { DesktopApp } from '../src/app.js';
import type { Backend, SupervisorState } from '../src/ipc.js';
import { $, config, flush, status, text } from './fixtures.js';

function fakeBackend(supervisor: SupervisorState = { state: 'running' }) {
  let current = status();
  let push: ((s: DaemonStatus) => void) | undefined;
  const calls: string[] = [];
  const backend: Backend = {
    getStatus: async () => current,
    getConfig: async () => config(),
    saveConfig: async (c) => {
      calls.push('saveConfig');
      return c;
    },
    setMode: async (mode) => {
      calls.push(`setMode:${mode}`);
      current = { ...current, mode };
    },
    resume: async () => {
      calls.push('resume');
      current = { ...current, mode: 'active' };
    },
    setKey: async () => {
      calls.push('setKey');
    },
    deleteKey: async () => {
      calls.push('deleteKey');
    },
    probeProvider: async () => ({ ok: true, models: [] }),
    restartWorker: async () => {
      calls.push('restart');
    },
    supervisorState: async () => supervisor,
    onStatus: async (callback) => {
      push = callback;
      return () => undefined;
    },
    onSupervisor: async () => () => undefined,
  };
  return { backend, calls, push: (s: DaemonStatus) => push?.(s) };
}

async function start(fake = fakeBackend()) {
  const root = document.createElement('div');
  const app = new DesktopApp(root, {
    backend: fake.backend,
    confirm: async () => true,
    disclosure: 'D',
  });
  await app.start();
  return { root, app, ...fake };
}

describe('DesktopApp', () => {
  it('renders status and applies live updates', async () => {
    const { root, push } = await start();
    expect(text(root)).toContain('Open Literature Demo');
    push(status({ today: { ...status().today, tasks_submitted: 239 } }));
    expect(text(root)).toContain('Tasks239');
  });

  it('pauses, then resumes to the remembered mode', async () => {
    const { root, calls } = await start();
    $(root, '[data-action="toggle-pause"]').click();
    await flush();
    expect(calls).toContain('setMode:paused');
    expect($(root, '[data-action="toggle-pause"]').textContent).toBe('Resume contributions');
    $(root, '[data-action="toggle-pause"]').click();
    await flush();
    expect(calls).toContain('resume');
  });

  it('keeps settings edits when status events arrive', async () => {
    const { root, push } = await start();
    $(root, '[data-tab="settings"]').click();
    await flush();
    const url = $<HTMLInputElement>(root, 'input[name="coordinator_url"]');
    url.value = 'https://edited.example.org';
    push(status({ connection: 'offline' }));
    expect($<HTMLInputElement>(root, 'input[name="coordinator_url"]').value).toBe(
      'https://edited.example.org',
    );
    expect($(root, '[data-live="connection"]').textContent).toBe('Offline');
    expect($(root, '[data-tab="settings"]').getAttribute('aria-selected')).toBe('true');
  });

  it('shows why the worker stopped and restarts it', async () => {
    const { root, calls } = await start(fakeBackend({ state: 'stopped', message: 'exit code 1' }));
    expect(text(root)).toContain('Worker stopped: exit code 1');
    $(root, '[data-action="restart"]').click();
    await flush();
    expect(calls).toContain('restart');
  });
});
```

Run: `pnpm --filter @ai-commons/desktop exec vitest run test/app.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 2: Implement `app.ts`**

```ts
// apps/desktop/src/app.ts
import type { DaemonStatus } from '@ai-commons/worker';
import { h, replaceContent } from './dom.js';
import { errorText } from './format.js';
import type { Backend, SupervisorState } from './ipc.js';
import { renderSettings } from './settings-view.js';
import { connectionLabel, renderStatus } from './status-view.js';

export interface AppOptions {
  backend: Backend;
  confirm: (message: string) => Promise<boolean>;
  disclosure: string;
}

type Tab = 'status' | 'settings';

export class DesktopApp {
  private status: DaemonStatus | undefined;
  private supervisor: SupervisorState = { state: 'running' };
  private tab: Tab = 'status';
  private notice: string | undefined;
  private readonly main: HTMLElement;
  private readonly tabs: Record<Tab, HTMLButtonElement>;

  constructor(
    root: HTMLElement,
    private readonly opts: AppOptions,
  ) {
    this.tabs = {
      status: this.tabButton('status', 'Status'),
      settings: this.tabButton('settings', 'Settings'),
    };
    this.main = h('main', { id: 'view' });
    root.replaceChildren(
      h(
        'header',
        { class: 'app-header' },
        h('h1', {}, 'AI Commons'),
        h('nav', { role: 'tablist' }, this.tabs.status, this.tabs.settings),
      ),
      this.main,
    );
  }

  async start(): Promise<void> {
    const { backend } = this.opts;
    await backend.onStatus((s) => this.onStatus(s));
    await backend.onSupervisor((s) => {
      this.supervisor = s;
      if (this.tab === 'status') this.renderStatusTab();
    });
    try {
      this.supervisor = await backend.supervisorState();
    } catch {
      // Keep the default; the next supervisor event corrects it.
    }
    try {
      this.onStatus(await backend.getStatus());
    } catch (error) {
      this.notice = errorText(error);
      this.renderStatusTab();
    }
  }

  select(tab: Tab): void {
    this.tab = tab;
    for (const [name, button] of Object.entries(this.tabs)) {
      button.setAttribute('aria-selected', String(name === tab));
    }
    if (tab === 'status') this.renderStatusTab();
    else void this.showSettings();
  }

  private onStatus(s: DaemonStatus): void {
    this.status = s;
    if (this.tab === 'status') {
      this.renderStatusTab();
      return;
    }
    // Never re-render the settings form under the user's edits.
    for (const el of this.main.querySelectorAll('[data-live="connection"]')) {
      el.textContent = connectionLabel(s).text;
    }
  }

  private renderStatusTab(): void {
    if (!this.status) {
      replaceContent(this.main, h('p', { class: 'muted' }, this.notice ?? 'Starting the worker…'));
      return;
    }
    replaceContent(
      this.main,
      renderStatus(
        this.status,
        this.supervisor,
        { onTogglePause: () => void this.togglePause(), onRestart: () => void this.restart() },
        this.notice,
      ),
    );
  }

  private async togglePause(): Promise<void> {
    if (!this.status) return;
    const { backend } = this.opts;
    try {
      if (this.status.mode === 'paused') await backend.resume();
      else await backend.setMode('paused');
      this.notice = undefined;
      this.onStatus(await backend.getStatus());
    } catch (error) {
      this.notice = errorText(error);
      this.renderStatusTab();
    }
  }

  private async restart(): Promise<void> {
    try {
      await this.opts.backend.restartWorker();
      this.notice = undefined;
    } catch (error) {
      this.notice = errorText(error);
    }
    this.renderStatusTab();
  }

  private async showSettings(): Promise<void> {
    const { backend, confirm, disclosure } = this.opts;
    replaceContent(this.main, h('p', { class: 'muted' }, 'Loading settings…'));
    try {
      const config = await backend.getConfig();
      if (this.tab !== 'settings') return;
      replaceContent(
        this.main,
        renderSettings(config, this.status, {
          onSave: async (next) => {
            await backend.saveConfig(next);
          },
          onProbe: (id, endpoint) => backend.probeProvider(id, endpoint),
          onSetKey: (provider, key) => backend.setKey(provider, key),
          onDeleteKey: (provider) => backend.deleteKey(provider),
          confirm,
          disclosure,
        }),
      );
    } catch (error) {
      replaceContent(
        this.main,
        h('p', { class: 'banner danger', role: 'alert' }, errorText(error)),
      );
    }
  }

  private tabButton(tab: Tab, label: string): HTMLButtonElement {
    const button = h(
      'button',
      {
        type: 'button',
        role: 'tab',
        'data-tab': tab,
        'aria-selected': tab === 'status' ? 'true' : 'false',
      },
      label,
    );
    button.addEventListener('click', () => this.select(tab));
    return button;
  }
}
```

- [ ] **Step 3: Implement `dialog.ts` and `main.ts`**

```ts
// apps/desktop/src/dialog.ts
import { h } from './dom.js';

/** In-page confirmation; avoids adding the Tauri dialog plugin. */
export function confirmDialog(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ok = h('button', { type: 'button', class: 'primary' }, 'I understand, enable it');
    const cancel = h('button', { type: 'button', class: 'secondary' }, 'Cancel');
    const dialog = h(
      'dialog',
      { class: 'confirm', 'aria-label': 'Confirm paid provider' },
      h('p', {}, message),
      h('div', { class: 'actions' }, cancel, ok),
    );
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    ok.addEventListener('click', () => finish(true));
    cancel.addEventListener('click', () => finish(false));
    dialog.addEventListener('cancel', () => finish(false));
    document.body.append(dialog);
    dialog.showModal();
  });
}
```

```ts
// apps/desktop/src/main.ts
import { REMOTE_DISCLOSURE } from '@ai-commons/worker/disclosure';
import { DesktopApp } from './app.js';
import { confirmDialog } from './dialog.js';
import { tauriBackend } from './ipc.js';
import './styles.css';

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app root element');

void new DesktopApp(root, {
  backend: tauriBackend(),
  confirm: confirmDialog,
  disclosure: REMOTE_DISCLOSURE,
}).start();
```

- [ ] **Step 4: Run tests, typecheck and build**

Run: `pnpm --filter @ai-commons/desktop exec vitest run && pnpm --filter @ai-commons/desktop typecheck && pnpm --filter @ai-commons/desktop build`
Expected:

- Tests PASS and typecheck is clean.
- `apps/desktop/dist/index.html` exists.
- `grep -c "local_models_only" apps/desktop/dist/assets/*.js` prints ≥ 1. That confirms the disclosure was bundled, and that no Node modules were pulled in (Vite would have failed on `node:` imports).

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/desktop/src apps/desktop/test
git commit -m "Add desktop app shell, confirmation dialog and entry point" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Phase C — Rust shell (`apps/desktop/src-tauri`)

`cargo test` compiles `tauri::generate_context!()`. That needs `apps/desktop/dist` (run `pnpm --filter @ai-commons/desktop build`), the icons, and the `runtime/` resource directory to exist. Task 13 creates all three.

### Task 13: Scaffold the Tauri crate

**Files:**

- Create:
  - `apps/desktop/src-tauri/Cargo.toml`, `build.rs`, `tauri.conf.json`, `capabilities/default.json`
  - `src/main.rs`, `src/lib.rs` (minimal)
  - `runtime/.gitkeep`
  - `apps/desktop/app-icon.svg`, `apps/desktop/src-tauri/icons/*` (generated)
- Modify: `.gitignore`, `.prettierignore`, `eslint.config.js`

- [ ] **Step 1: Crate files**

```toml
# apps/desktop/src-tauri/Cargo.toml
[package]
name = "ai-commons-desktop"
version = "0.1.0"
description = "AI Commons desktop worker"
license = "Apache-2.0"
edition = "2021"
rust-version = "1.90"

[lib]
name = "ai_commons_desktop_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = ["tray-icon"] }
tauri-plugin-single-instance = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["sync", "time"] }

[target.'cfg(windows)'.dependencies]
windows-sys = { version = "0.59", features = [
  "Win32_Foundation",
  "Win32_System_SystemInformation",
  "Win32_UI_Input_KeyboardAndMouse",
] }

[dev-dependencies]
tokio = { version = "1", features = ["macros", "rt-multi-thread", "sync", "time"] }
```

```rust
// apps/desktop/src-tauri/build.rs
fn main() {
    tauri_build::build()
}
```

```rust
// apps/desktop/src-tauri/src/main.rs
// No console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ai_commons_desktop_lib::run()
}
```

```rust
// apps/desktop/src-tauri/src/lib.rs  (temporary; replaced in Task 18)
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running AI Commons");
}
```

```json
// apps/desktop/src-tauri/tauri.conf.json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "AI Commons",
  "version": "0.1.0",
  "identifier": "org.aicommons.desktop",
  "build": {
    "frontendDist": "../dist",
    "devUrl": "http://localhost:5173",
    "beforeDevCommand": "pnpm dev",
    "beforeBuildCommand": "pnpm build && pnpm stage"
  },
  "app": {
    "windows": [
      {
        "label": "main",
        "title": "AI Commons",
        "width": 440,
        "height": 700,
        "minWidth": 380,
        "minHeight": 520
      }
    ],
    "security": {
      "csp": "default-src 'self'; style-src 'self'; img-src 'self' data:; connect-src ipc: http://ipc.localhost",
      "devCsp": null
    }
  },
  "bundle": {
    "active": true,
    "targets": ["nsis"],
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ],
    "resources": ["runtime/"],
    "windows": {
      "nsis": { "installMode": "currentUser" }
    }
  }
}
```

```json
// apps/desktop/src-tauri/capabilities/default.json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Main window: event listening only. Worker access goes through the app's own commands (daemon_request allow-lists methods).",
  "windows": ["main"],
  "permissions": ["core:event:default"]
}
```

Create an empty `apps/desktop/src-tauri/runtime/.gitkeep`.

- [ ] **Step 2: Icon**

```svg
<!-- apps/desktop/app-icon.svg -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" rx="224" fill="#0f766e"/>
  <path d="M512 300 L330 620 M512 300 L694 620 M330 620 L694 620" fill="none" stroke="#ffffff" stroke-width="56" stroke-linecap="round"/>
  <circle cx="512" cy="300" r="96" fill="#ffffff"/>
  <circle cx="330" cy="620" r="96" fill="#ffffff"/>
  <circle cx="694" cy="620" r="96" fill="#ffffff"/>
</svg>
```

Run from `apps/desktop`: `cargo tauri icon app-icon.svg`
Expected: `src-tauri/icons/` contains `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.icns`, `icon.ico` and others.

If the CLI rejects SVG input, render a 1024×1024 PNG with Playwright and pass that file instead:

1. Open the SVG in a browser page.
2. Take a screenshot.
3. Save it as `apps/desktop/app-icon.png`.

- [ ] **Step 3: Ignore generated files**

Add to `.gitignore`:

```
apps/desktop/src-tauri/target/
apps/desktop/src-tauri/gen/
apps/desktop/src-tauri/runtime/*
!apps/desktop/src-tauri/runtime/.gitkeep
```

- Add `apps/desktop/src-tauri/target/`, `apps/desktop/src-tauri/gen/` and `apps/desktop/src-tauri/runtime/` to `.prettierignore`.
- Add `'**/src-tauri/**'` to the ESLint `ignores`.

- [ ] **Step 4: Build**

Run:

```bash
pnpm --filter @ai-commons/desktop build
cd apps/desktop/src-tauri && cargo build
```

Expected: the build compiles; the first build takes several minutes. `Cargo.lock` is created, so commit it, since this is an application.

- [ ] **Step 5: Commit**

```bash
cd ../../..
pnpm format
git add apps/desktop/src-tauri apps/desktop/app-icon.svg .gitignore .prettierignore eslint.config.js
git commit -m "Scaffold Tauri shell for the desktop worker" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Line framing (`framing.rs`)

**Files:** Create `apps/desktop/src-tauri/src/framing.rs`; add `mod framing;` to `lib.rs`.

- [ ] **Step 1: Write the module with its tests (tests first in the file; run them before the impl compiles by stubbing `next_frame` with `todo!()`, confirm failure, then fill it in)**

```rust
// apps/desktop/src-tauri/src/framing.rs
//! Newline-delimited framing for the daemon's stdout, with a hard line-length cap.

use std::io::{self, BufRead};

/// Mirrors `DAEMON_MAX_LINE_BYTES` in apps/worker/src/daemon/protocol.ts.
pub const MAX_LINE_BYTES: usize = 1_000_000;

#[derive(Debug, PartialEq, Eq)]
pub enum Frame {
    Line(String),
    /// A line longer than the cap; its bytes were discarded.
    Oversized,
    Eof,
}

pub struct LineReader<R> {
    inner: R,
    max: usize,
}

impl<R: BufRead> LineReader<R> {
    pub fn new(inner: R, max: usize) -> Self {
        Self { inner, max }
    }

    pub fn next_frame(&mut self) -> io::Result<Frame> {
        let mut line: Vec<u8> = Vec::new();
        let mut oversized = false;
        loop {
            let (consumed, complete) = {
                let available = self.inner.fill_buf()?;
                if available.is_empty() {
                    return Ok(if oversized {
                        Frame::Oversized
                    } else if line.is_empty() {
                        Frame::Eof
                    } else {
                        Frame::Line(decode(&line))
                    });
                }
                let newline = available.iter().position(|&b| b == b'\n');
                let chunk = &available[..newline.unwrap_or(available.len())];
                if !oversized {
                    if line.len() + chunk.len() > self.max {
                        oversized = true;
                        line.clear();
                    } else {
                        line.extend_from_slice(chunk);
                    }
                }
                (newline.map_or(available.len(), |i| i + 1), newline.is_some())
            };
            self.inner.consume(consumed);
            if complete {
                return Ok(if oversized { Frame::Oversized } else { Frame::Line(decode(&line)) });
            }
        }
    }
}

fn decode(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    text.strip_suffix('\r').unwrap_or(&text).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufReader, Cursor};

    fn frames(input: &str, max: usize) -> Vec<Frame> {
        let mut reader = LineReader::new(Cursor::new(input.as_bytes().to_vec()), max);
        let mut out = Vec::new();
        loop {
            let frame = reader.next_frame().unwrap();
            let end = frame == Frame::Eof;
            out.push(frame);
            if end {
                return out;
            }
        }
    }

    fn line(s: &str) -> Frame {
        Frame::Line(s.to_string())
    }

    #[test]
    fn splits_lines_and_strips_crlf() {
        assert_eq!(frames("a\r\nbc\n", 10), vec![line("a"), line("bc"), Frame::Eof]);
    }

    #[test]
    fn returns_a_trailing_partial_line() {
        assert_eq!(frames("a\nb", 10), vec![line("a"), line("b"), Frame::Eof]);
    }

    #[test]
    fn skips_oversized_lines_and_recovers() {
        assert_eq!(
            frames("0123456789AB\nok\n", 10),
            vec![Frame::Oversized, line("ok"), Frame::Eof]
        );
    }

    #[test]
    fn allows_a_line_of_exactly_the_cap() {
        assert_eq!(frames("0123456789\n", 10), vec![line("0123456789"), Frame::Eof]);
    }

    #[test]
    fn handles_lines_split_across_reads() {
        let inner = BufReader::with_capacity(4, Cursor::new(b"hello world\nx\n".to_vec()));
        let mut reader = LineReader::new(inner, 100);
        assert_eq!(reader.next_frame().unwrap(), line("hello world"));
        assert_eq!(reader.next_frame().unwrap(), line("x"));
        assert_eq!(reader.next_frame().unwrap(), Frame::Eof);
    }

    #[test]
    fn empty_input_is_eof() {
        assert_eq!(frames("", 10), vec![Frame::Eof]);
    }
}
```

- [ ] **Step 2: Run the tests**

Run: `cd apps/desktop/src-tauri && cargo test framing`
Expected: 6 tests PASS. Unused-code warnings are fine until Task 18.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src
git commit -m "Add capped line framing for the daemon relay" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Idle tracking (`idle.rs`, tracker + OS query)

**Files:** Create `apps/desktop/src-tauri/src/idle.rs`; add `mod idle;` to `lib.rs`. The poller that sends `setIdle` is added in Task 18, when the supervisor exists.

- [ ] **Step 1: Write the module and tests**

```rust
// apps/desktop/src-tauri/src/idle.rs
//! OS idle detection for `idle_only` scheduling.

use std::time::Duration;

pub const POLL_INTERVAL: Duration = Duration::from_secs(15);
pub const DEFAULT_THRESHOLD: Duration = Duration::from_secs(5 * 60);

/// Turns "time since last input" samples into idle/active transitions.
#[derive(Debug)]
pub struct IdleTracker {
    threshold: Duration,
    last: Option<bool>,
}

impl IdleTracker {
    pub fn new(threshold: Duration) -> Self {
        Self { threshold, last: None }
    }

    pub fn set_threshold(&mut self, threshold: Duration) {
        self.threshold = threshold;
    }

    /// Forget the last reported state so the next sample is reported again
    /// (a restarted daemon starts out "not idle").
    pub fn reset(&mut self) {
        self.last = None;
    }

    /// Returns the new state when it differs from the last reported one.
    pub fn update(&mut self, since_input: Duration) -> Option<bool> {
        let idle = since_input >= self.threshold;
        if self.last == Some(idle) {
            return None;
        }
        self.last = Some(idle);
        Some(idle)
    }
}

/// Time since the last keyboard or mouse input in this session, if the OS can tell us.
#[cfg(windows)]
pub fn time_since_last_input() -> Option<Duration> {
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

    let mut info = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    // SAFETY: `info` is a correctly sized, writable LASTINPUTINFO.
    if unsafe { GetLastInputInfo(&mut info) } == 0 {
        return None;
    }
    // SAFETY: GetTickCount has no preconditions.
    let now = unsafe { GetTickCount() };
    // Both are 32-bit millisecond tick counts; wrapping_sub survives the 49.7-day rollover.
    Some(Duration::from_millis(u64::from(now.wrapping_sub(info.dwTime))))
}

#[cfg(not(windows))]
pub fn time_since_last_input() -> Option<Duration> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    #[test]
    fn reports_the_first_sample_then_only_changes() {
        let mut t = IdleTracker::new(secs(300));
        assert_eq!(t.update(secs(10)), Some(false));
        assert_eq!(t.update(secs(20)), None);
        assert_eq!(t.update(secs(300)), Some(true));
        assert_eq!(t.update(secs(900)), None);
        assert_eq!(t.update(secs(0)), Some(false));
    }

    #[test]
    fn threshold_changes_apply_to_the_next_sample() {
        let mut t = IdleTracker::new(secs(300));
        assert_eq!(t.update(secs(120)), Some(false));
        t.set_threshold(secs(60));
        assert_eq!(t.update(secs(120)), Some(true));
    }

    #[test]
    fn reset_reports_the_current_state_again() {
        let mut t = IdleTracker::new(secs(300));
        assert_eq!(t.update(secs(10)), Some(false));
        t.reset();
        assert_eq!(t.update(secs(10)), Some(false));
    }

    #[cfg(windows)]
    #[test]
    fn reads_os_idle_time() {
        assert!(time_since_last_input().is_some());
    }
}
```

- [ ] **Step 2: Run the tests**

Run: `cargo test idle`
Expected: 4 tests PASS on Windows.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src
git commit -m "Add idle tracker backed by GetLastInputInfo" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Daemon process client (`daemon.rs`)

**Files:** Create `apps/desktop/src-tauri/src/daemon.rs`; add `mod daemon;` to `lib.rs`.

- [ ] **Step 1: Write the module and tests**

```rust
// apps/desktop/src-tauri/src/daemon.rs
//! Spawns the Node worker daemon and speaks its stdio protocol.
//! Request params can carry API keys: never log them.

use std::collections::HashMap;
use std::io::{self, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::framing::{Frame, LineReader, MAX_LINE_BYTES};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// Locks a mutex, ignoring poisoning (a panicked holder must not wedge the app).
pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[derive(Clone, Debug)]
pub struct DaemonPaths {
    pub node: PathBuf,
    pub script: PathBuf,
}

impl DaemonPaths {
    /// Layout produced by apps/desktop/scripts/stage-runtime.ts.
    pub fn in_resources(resource_dir: &Path) -> Self {
        let runtime = resource_dir.join("runtime");
        Self {
            node: runtime.join(if cfg!(windows) { "node.exe" } else { "node" }),
            script: runtime.join("daemon").join("worker-daemon.mjs"),
        }
    }
}

#[derive(Debug, PartialEq)]
pub enum Incoming {
    Status(Value),
    Response { id: String, result: Result<Value, String> },
    Ignored,
}

pub fn parse_incoming(line: &str) -> Incoming {
    let Ok(message) = serde_json::from_str::<Value>(line) else {
        return Incoming::Ignored;
    };
    if let Some(event) = message.get("event") {
        return match (event.as_str(), message.get("data")) {
            (Some("status"), Some(data)) => Incoming::Status(data.clone()),
            _ => Incoming::Ignored,
        };
    }
    let Some(id) = message.get("id").and_then(Value::as_str) else {
        return Incoming::Ignored;
    };
    let result = if message.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(message.get("result").cloned().unwrap_or(Value::Null))
    } else {
        Err(message
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("The worker reported an error")
            .to_string())
    };
    Incoming::Response { id: id.to_string(), result }
}

pub fn request_line(id: &str, method: &str, params: &Value) -> Result<String, String> {
    let line = serde_json::to_string(&json!({ "id": id, "method": method, "params": params }))
        .map_err(|_| "Could not encode the request".to_string())?;
    if line.len() > MAX_LINE_BYTES {
        return Err("The request is too large".into());
    }
    Ok(line)
}

type Pending = HashMap<String, oneshot::Sender<Result<Value, String>>>;

pub struct DaemonHandle {
    stdin: Mutex<ChildStdin>,
    pending: Mutex<Pending>,
    next_id: AtomicU64,
    child: Mutex<Child>,
    exited: AtomicBool,
}

/// Starts the daemon. `on_event` receives each status payload; `on_exit` runs once
/// on the reader thread after the process has exited.
pub fn spawn<E, X>(paths: &DaemonPaths, on_event: E, on_exit: X) -> io::Result<Arc<DaemonHandle>>
where
    E: Fn(Value) + Send + 'static,
    X: FnOnce(Option<i32>) + Send + 'static,
{
    let mut command = Command::new(&paths.node);
    command
        .arg(&paths.script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn()?;
    let missing = || io::Error::other("child stdio was not captured");
    let stdin = child.stdin.take().ok_or_else(missing)?;
    let stdout = child.stdout.take().ok_or_else(missing)?;
    let mut stderr = child.stderr.take().ok_or_else(missing)?;

    let handle = Arc::new(DaemonHandle {
        stdin: Mutex::new(stdin),
        pending: Mutex::new(HashMap::new()),
        next_id: AtomicU64::new(1),
        child: Mutex::new(child),
        exited: AtomicBool::new(false),
    });

    // The daemon logs to worker.log as well; drain stderr so a full pipe never blocks it.
    std::thread::spawn(move || {
        let mut sink = [0u8; 8192];
        while matches!(stderr.read(&mut sink), Ok(n) if n > 0) {}
    });

    let reader = handle.clone();
    std::thread::spawn(move || {
        let mut lines = LineReader::new(BufReader::new(stdout), MAX_LINE_BYTES);
        loop {
            match lines.next_frame() {
                Ok(Frame::Line(line)) => match parse_incoming(&line) {
                    Incoming::Status(data) => on_event(data),
                    Incoming::Response { id, result } => {
                        if let Some(tx) = lock(&reader.pending).remove(&id) {
                            let _ = tx.send(result);
                        }
                    }
                    Incoming::Ignored => {}
                },
                Ok(Frame::Oversized) => {}
                Ok(Frame::Eof) | Err(_) => break,
            }
        }
        for (_, tx) in lock(&reader.pending).drain() {
            let _ = tx.send(Err("The worker stopped".into()));
        }
        let code = lock(&reader.child).wait().ok().and_then(|status| status.code());
        reader.exited.store(true, Ordering::SeqCst);
        on_exit(code);
    });

    Ok(handle)
}

impl DaemonHandle {
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = format!("r{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        let line = request_line(&id, method, &params)?;
        let (tx, rx) = oneshot::channel();
        lock(&self.pending).insert(id.clone(), tx);
        if self.write_line(&line).is_err() {
            lock(&self.pending).remove(&id);
            return Err("The worker is not running".into());
        }
        match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("The worker stopped".into()),
            Err(_) => {
                lock(&self.pending).remove(&id);
                Err("The worker did not respond in time".into())
            }
        }
    }

    fn write_line(&self, line: &str) -> io::Result<()> {
        let mut stdin = lock(&self.stdin);
        stdin.write_all(line.as_bytes())?;
        stdin.write_all(b"\n")?;
        stdin.flush()
    }

    pub fn has_exited(&self) -> bool {
        self.exited.load(Ordering::SeqCst)
    }

    pub async fn wait_exit(&self) {
        while !self.has_exited() {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    pub fn kill(&self) {
        let _ = lock(&self.child).kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_status_events() {
        assert_eq!(
            parse_incoming(r#"{"event":"status","data":{"mode":"active"}}"#),
            Incoming::Status(json!({ "mode": "active" }))
        );
    }

    #[test]
    fn parses_success_and_error_responses() {
        assert_eq!(
            parse_incoming(r#"{"id":"r1","ok":true,"result":{"stored":true}}"#),
            Incoming::Response { id: "r1".into(), result: Ok(json!({ "stored": true })) }
        );
        assert_eq!(
            parse_incoming(r#"{"id":"r2","ok":false,"error":{"code":"internal","message":"nope"}}"#),
            Incoming::Response { id: "r2".into(), result: Err("nope".into()) }
        );
    }

    #[test]
    fn ignores_garbage_and_unknown_messages() {
        for line in ["", "nope", "[]", r#"{"event":"other","data":{}}"#, r#"{"ok":true}"#] {
            assert_eq!(parse_incoming(line), Incoming::Ignored, "{line}");
        }
    }

    #[test]
    fn request_lines_are_single_json_lines() {
        let line = request_line("r1", "setMode", &json!({ "mode": "paused" })).unwrap();
        assert!(!line.contains('\n'));
        assert_eq!(
            serde_json::from_str::<Value>(&line).unwrap(),
            json!({ "id": "r1", "method": "setMode", "params": { "mode": "paused" } })
        );
    }

    #[test]
    fn refuses_oversized_requests() {
        let big = "x".repeat(MAX_LINE_BYTES);
        assert!(request_line("r1", "setKey", &json!({ "key": big })).is_err());
    }

    #[test]
    fn resolves_runtime_paths() {
        let paths = DaemonPaths::in_resources(Path::new("app"));
        let node = if cfg!(windows) { "node.exe" } else { "node" };
        assert!(paths.node.ends_with(Path::new("runtime").join(node)));
        assert!(paths.script.ends_with(Path::new("runtime").join("daemon").join("worker-daemon.mjs")));
    }

    const ECHO_SCRIPT: &str = r#"
import { createInterface } from 'node:readline';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
send({ event: 'status', data: { mode: 'active' } });
process.stderr.write('noise on stderr\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === 'echo') send({ id, ok: true, result: params });
  else if (method === 'fail') send({ id, ok: false, error: { code: 'internal', message: 'nope' } });
  else if (method === 'exit') process.exit(0);
});
"#;

    /// Needs `node` on PATH (it is on every dev machine for this repo).
    #[tokio::test]
    async fn round_trips_requests_through_a_child_process() {
        let dir = std::env::temp_dir().join(format!("aic-daemon-rs-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("echo.mjs");
        std::fs::write(&script, ECHO_SCRIPT).unwrap();
        let paths = DaemonPaths { node: PathBuf::from("node"), script };

        let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel();
        let (exit_tx, exit_rx) = oneshot::channel();
        let handle = spawn(
            &paths,
            move |data| {
                let _ = event_tx.send(data);
            },
            move |code| {
                let _ = exit_tx.send(code);
            },
        )
        .unwrap();

        let status = tokio::time::timeout(Duration::from_secs(10), event_rx.recv()).await.unwrap();
        assert_eq!(status, Some(json!({ "mode": "active" })));
        assert_eq!(handle.request("echo", json!({ "n": 1 })).await, Ok(json!({ "n": 1 })));
        assert_eq!(handle.request("fail", json!({})).await, Err("nope".to_string()));

        // The daemon exits without answering; the pending request must fail, not hang.
        assert_eq!(handle.request("exit", json!({})).await, Err("The worker stopped".to_string()));
        let code = tokio::time::timeout(Duration::from_secs(10), exit_rx).await.unwrap().unwrap();
        assert_eq!(code, Some(0));
        assert!(handle.has_exited());
        let _ = std::fs::remove_dir_all(dir);
    }
}
```

- [ ] **Step 2: Run the tests**

Run: `cargo test daemon`
Expected: 7 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src
git commit -m "Add daemon process client with request routing" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 17: Supervisor (`supervisor.rs`)

**Files:** Create `apps/desktop/src-tauri/src/supervisor.rs`; add `mod supervisor;` to `lib.rs`.

- [ ] **Step 1: Write the module and tests**

```rust
// apps/desktop/src-tauri/src/supervisor.rs
//! Keeps the worker daemon running, relays its status to the UI and tray, and
//! shuts it down gracefully on quit.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::menu::MenuItem;
use tauri::tray::TrayIcon;
use tauri::{AppHandle, Emitter, Wry};

use crate::daemon::{self, lock, DaemonHandle, DaemonPaths};
use crate::idle::{IdleTracker, DEFAULT_THRESHOLD};

const MAX_CRASHES: usize = 5;
const CRASH_WINDOW: Duration = Duration::from_secs(5 * 60);

/// Backoff 1 s, 2 s, 4 s, 8 s; gives up on the 5th crash within 5 minutes.
pub struct RestartPolicy {
    crashes: VecDeque<Instant>,
}

impl RestartPolicy {
    pub fn new() -> Self {
        Self { crashes: VecDeque::new() }
    }

    /// Records a crash; returns the delay before restarting, or None to give up.
    pub fn on_crash(&mut self, now: Instant) -> Option<Duration> {
        while let Some(&first) = self.crashes.front() {
            if now.duration_since(first) > CRASH_WINDOW {
                self.crashes.pop_front();
            } else {
                break;
            }
        }
        self.crashes.push_back(now);
        if self.crashes.len() >= MAX_CRASHES {
            return None;
        }
        Some(Duration::from_secs(1 << (self.crashes.len() - 1)))
    }

    pub fn reset(&mut self) {
        self.crashes.clear();
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SupervisorState {
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

pub fn tooltip(connection: &str, mode: &str, idle: bool) -> String {
    let state = match (connection, mode) {
        (_, "paused") => "Paused",
        ("offline", _) => "Offline",
        ("unconfigured", _) => "Not set up",
        ("connected", "idle_only") if !idle => "Waiting for idle",
        ("connected", _) => "Contributing",
        _ => "Connecting",
    };
    format!("AI Commons — {state}")
}

fn exit_code(code: Option<i32>) -> String {
    code.map_or_else(|| "none".to_string(), |c| c.to_string())
}

pub struct Supervisor {
    app: AppHandle,
    paths: DaemonPaths,
    handle: Mutex<Option<Arc<DaemonHandle>>>,
    policy: Mutex<RestartPolicy>,
    state: Mutex<SupervisorState>,
    mode: Mutex<String>,
    idle: Mutex<IdleTracker>,
    quitting: AtomicBool,
    toggle: MenuItem<Wry>,
    tray: TrayIcon<Wry>,
}

impl Supervisor {
    pub fn new(app: AppHandle, paths: DaemonPaths, toggle: MenuItem<Wry>, tray: TrayIcon<Wry>) -> Arc<Self> {
        Arc::new(Self {
            app,
            paths,
            handle: Mutex::new(None),
            policy: Mutex::new(RestartPolicy::new()),
            state: Mutex::new(SupervisorState { state: "running", message: None }),
            mode: Mutex::new("active".into()),
            idle: Mutex::new(IdleTracker::new(DEFAULT_THRESHOLD)),
            quitting: AtomicBool::new(false),
            toggle,
            tray,
        })
    }

    pub fn start(self: &Arc<Self>) {
        if self.quitting.load(Ordering::SeqCst) {
            return;
        }
        let mut slot = lock(&self.handle);
        if slot.is_some() {
            return;
        }
        let weak = Arc::downgrade(self);
        let events = weak.clone();
        let on_event = move |data: Value| {
            if let Some(me) = events.upgrade() {
                me.on_status(data);
            }
        };
        let on_exit = move |code: Option<i32>| {
            if let Some(me) = weak.upgrade() {
                me.on_exit(code);
            }
        };
        match daemon::spawn(&self.paths, on_event, on_exit) {
            Ok(handle) => {
                *slot = Some(handle);
                drop(slot);
                lock(&self.idle).reset();
                self.set_state("running", None);
            }
            Err(error) => {
                drop(slot);
                self.set_state("stopped", Some(format!("Could not start the worker runtime: {error}")));
            }
        }
    }

    /// User-requested restart from the UI: forget earlier crashes.
    pub fn restart(self: &Arc<Self>) {
        lock(&self.policy).reset();
        self.start();
    }

    pub fn handle(&self) -> Option<Arc<DaemonHandle>> {
        lock(&self.handle).clone()
    }

    pub fn state(&self) -> SupervisorState {
        lock(&self.state).clone()
    }

    pub fn idle_tracker(&self) -> MutexGuard<'_, IdleTracker> {
        lock(&self.idle)
    }

    pub fn send_idle(&self, idle: bool) {
        if let Some(handle) = self.handle() {
            tauri::async_runtime::spawn(async move {
                let _ = handle.request("setIdle", json!({ "idle": idle })).await;
            });
        }
    }

    pub async fn toggle_pause(&self) {
        let paused = *lock(&self.mode) == "paused";
        if let Some(handle) = self.handle() {
            let _ = if paused {
                handle.request("resume", json!({})).await
            } else {
                handle.request("setMode", json!({ "mode": "paused" })).await
            };
        }
    }

    /// Drain (finish the current task) for up to 30 s, then kill. Killing mid-call
    /// is budget-safe: stale reservations are charged in full on the next start.
    pub async fn shutdown(&self) {
        self.quitting.store(true, Ordering::SeqCst);
        let Some(handle) = self.handle() else { return };
        let _ = tokio::time::timeout(Duration::from_secs(5), handle.request("shutdown", json!({}))).await;
        if tokio::time::timeout(Duration::from_secs(30), handle.wait_exit()).await.is_err() {
            handle.kill();
        }
    }

    fn on_status(&self, data: Value) {
        let mode = data["mode"].as_str().unwrap_or("active").to_string();
        let connection = data["connection"].as_str().unwrap_or("connecting");
        let idle = data["idle"].as_bool().unwrap_or(false);
        let minutes = data["idle_after_minutes"].as_u64().unwrap_or(5).clamp(1, 240);
        lock(&self.idle).set_threshold(Duration::from_secs(minutes * 60));
        let _ = self.toggle.set_text(if mode == "paused" { "Resume contributions" } else { "Pause contributions" });
        let _ = self.tray.set_tooltip(Some(tooltip(connection, &mode, idle)));
        *lock(&self.mode) = mode;
        let _ = self.app.emit("worker-event", data);
    }

    fn on_exit(self: &Arc<Self>, code: Option<i32>) {
        {
            let mut slot = lock(&self.handle);
            // Only clear the slot if it still holds the process that exited.
            if slot.as_ref().is_some_and(|h| h.has_exited()) {
                *slot = None;
            }
        }
        if self.quitting.load(Ordering::SeqCst) {
            return;
        }
        let delay = lock(&self.policy).on_crash(Instant::now());
        match delay {
            Some(delay) => {
                self.set_state(
                    "restarting",
                    Some(format!("The worker exited (code {}); restarting in {} s.", exit_code(code), delay.as_secs())),
                );
                let me = self.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(delay);
                    me.start();
                });
            }
            None => self.set_state(
                "stopped",
                Some(format!(
                    "The worker exited repeatedly (last code {}). Details are in worker.log.",
                    exit_code(code)
                )),
            ),
        }
    }

    fn set_state(&self, state: &'static str, message: Option<String>) {
        let next = SupervisorState { state, message };
        *lock(&self.state) = next.clone();
        let _ = self.app.emit("supervisor", next);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    #[test]
    fn backs_off_then_gives_up_on_the_fifth_crash() {
        let mut policy = RestartPolicy::new();
        let t0 = Instant::now();
        let delays: Vec<_> = (0..5).map(|i| policy.on_crash(t0 + secs(i))).collect();
        assert_eq!(delays, vec![Some(secs(1)), Some(secs(2)), Some(secs(4)), Some(secs(8)), None]);
    }

    #[test]
    fn forgets_crashes_older_than_the_window() {
        let mut policy = RestartPolicy::new();
        let t0 = Instant::now();
        for i in 0..4 {
            policy.on_crash(t0 + secs(i));
        }
        assert_eq!(policy.on_crash(t0 + secs(400)), Some(secs(1)));
    }

    #[test]
    fn reset_clears_history() {
        let mut policy = RestartPolicy::new();
        let t0 = Instant::now();
        for i in 0..4 {
            policy.on_crash(t0 + secs(i));
        }
        policy.reset();
        assert_eq!(policy.on_crash(t0 + secs(5)), Some(secs(1)));
    }

    #[test]
    fn tooltip_reflects_state() {
        assert_eq!(tooltip("connected", "active", false), "AI Commons — Contributing");
        assert_eq!(tooltip("connected", "paused", false), "AI Commons — Paused");
        assert_eq!(tooltip("connected", "idle_only", false), "AI Commons — Waiting for idle");
        assert_eq!(tooltip("connected", "idle_only", true), "AI Commons — Contributing");
        assert_eq!(tooltip("offline", "active", false), "AI Commons — Offline");
        assert_eq!(tooltip("unconfigured", "active", false), "AI Commons — Not set up");
        assert_eq!(tooltip("connecting", "active", false), "AI Commons — Connecting");
    }
}
```

- [ ] **Step 2: Run the tests**

Run: `cargo test supervisor`
Expected: 4 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src
git commit -m "Add daemon supervisor with restart backoff and tray status" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 18: Wire the app (`lib.rs`): commands, tray, close-to-tray, single instance, idle poller

**Files:** Replace `apps/desktop/src-tauri/src/lib.rs`.

- [ ] **Step 1: Write `lib.rs`**

```rust
// apps/desktop/src-tauri/src/lib.rs
mod daemon;
mod framing;
mod idle;
mod supervisor;

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State, WindowEvent};

use supervisor::{Supervisor, SupervisorState};

/// Daemon methods the webview may call. `setIdle` and `shutdown` belong to the shell.
const UI_METHODS: &[&str] = &[
    "getStatus",
    "getConfig",
    "saveConfig",
    "setMode",
    "resume",
    "setKey",
    "deleteKey",
    "probeProvider",
];

/// Params may contain an API key (`setKey`): never log them.
#[tauri::command]
async fn daemon_request(
    supervisor: State<'_, Arc<Supervisor>>,
    method: String,
    params: Option<Value>,
) -> Result<Value, String> {
    if !UI_METHODS.contains(&method.as_str()) {
        return Err(format!("Method {method} is not available"));
    }
    let handle = supervisor.handle().ok_or_else(|| "The worker is not running".to_string())?;
    handle.request(&method, params.unwrap_or_else(|| json!({}))).await
}

#[tauri::command]
fn restart_worker(supervisor: State<'_, Arc<Supervisor>>) {
    supervisor.restart();
}

#[tauri::command]
fn supervisor_state(supervisor: State<'_, Arc<Supervisor>>) -> SupervisorState {
    supervisor.state()
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn supervisor_of(app: &AppHandle) -> Arc<Supervisor> {
    app.state::<Arc<Supervisor>>().inner().clone()
}

fn spawn_idle_poller(supervisor: Arc<Supervisor>) {
    std::thread::spawn(move || loop {
        // Unknown idle time counts as "in use": never contribute on a guess.
        let since = idle::time_since_last_input().unwrap_or(Duration::ZERO);
        let change = supervisor.idle_tracker().update(since);
        if let Some(is_idle) = change {
            supervisor.send_idle(is_idle);
        }
        std::thread::sleep(idle::POLL_INTERVAL);
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be registered first: a second launch just focuses the running app.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| show_main(app)))
        .invoke_handler(tauri::generate_handler![daemon_request, restart_worker, supervisor_state])
        .on_window_event(|window, event| {
            // Closing the window keeps contributing from the tray; Quit is in the tray menu.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            let toggle = MenuItemBuilder::with_id("toggle", "Pause contributions").build(app)?;
            let menu = MenuBuilder::new(app)
                .text("open", "Open AI Commons")
                .item(&toggle)
                .separator()
                .text("quit", "Quit")
                .build()?;
            let icon = app.default_window_icon().cloned().ok_or("missing app icon")?;
            let tray = TrayIconBuilder::with_id("main")
                .icon(icon)
                .tooltip("AI Commons")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main(app),
                    "toggle" => {
                        let supervisor = supervisor_of(app);
                        tauri::async_runtime::spawn(async move { supervisor.toggle_pause().await });
                    }
                    "quit" => {
                        let app = app.clone();
                        let supervisor = supervisor_of(&app);
                        tauri::async_runtime::spawn(async move {
                            supervisor.shutdown().await;
                            app.exit(0);
                        });
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            let paths = daemon::DaemonPaths::in_resources(&app.path().resource_dir()?);
            let supervisor = Supervisor::new(app.handle().clone(), paths, toggle, tray);
            app.manage(supervisor.clone());
            supervisor.start();
            spawn_idle_poller(supervisor);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running AI Commons");
}
```

API names to check if compilation fails (these changed during 2.x):

- `show_menu_on_left_click` was `menu_on_left_click` before Tauri 2.2.
- `event.id()` is the method form; the field `event.id` also works.

Fix only what the compiler reports.

- [ ] **Step 2: Build and run the whole Rust test suite**

Run: `cargo build && cargo test && cargo clippy -- -D warnings`
Expected: builds; all 21 Rust tests PASS; clippy is clean. The unused `DEFAULT_THRESHOLD`/`POLL_INTERVAL` warnings from earlier tasks should be gone. If clippy flags `new_without_default` on `RestartPolicy`, add `impl Default for RestartPolicy { fn default() -> Self { Self::new() } }`.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri
git commit -m "Wire desktop shell: commands, tray, close-to-tray, idle poller" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Phase D — Packaging, end-to-end verification, docs

### Task 19: Stage the runtime and build the NSIS installer

**Files:** Create `apps/desktop/scripts/stage-runtime.ts`.

- [ ] **Step 1: Write the staging script**

```ts
// apps/desktop/scripts/stage-runtime.ts
// Copies the Node runtime, the bundled worker daemon and the keyring native addon
// into src-tauri/runtime/, which Tauri ships as resources. Windows x64 only for now.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const runtime = join(here, '..', 'src-tauri', 'runtime');
const workerDir = join(here, '..', '..', 'worker');
const bundle = join(workerDir, 'dist-daemon', 'worker-daemon.mjs');

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error(
    `Staging supports Windows x64 only (running ${process.platform}-${process.arch}).`,
  );
}
const major = Number(process.versions.node.split('.')[0]);
if (major !== 24) {
  throw new Error(
    `Stage with Node 24: the running node binary is what gets shipped (this is ${process.version}).`,
  );
}
if (!existsSync(bundle)) {
  throw new Error(
    'Missing worker daemon bundle. Run "pnpm --filter @ai-commons/worker bundle:daemon".',
  );
}

for (const entry of ['node.exe', 'daemon'])
  rmSync(join(runtime, entry), { recursive: true, force: true });
mkdirSync(join(runtime, 'daemon', 'node_modules', '@napi-rs'), { recursive: true });

cpSync(process.execPath, join(runtime, 'node.exe'));
cpSync(bundle, join(runtime, 'daemon', 'worker-daemon.mjs'));

// The native keyring cannot be bundled: ship the package and its platform binary so
// `import('@napi-rs/keyring')` resolves from runtime/daemon/node_modules.
const fromWorker = createRequire(join(workerDir, 'package.json'));
const keyringDir = dirname(fromWorker.resolve('@napi-rs/keyring/package.json'));
const fromKeyring = createRequire(join(keyringDir, 'package.json'));
const platformDir = dirname(fromKeyring.resolve('@napi-rs/keyring-win32-x64-msvc/package.json'));
const modules = join(runtime, 'daemon', 'node_modules', '@napi-rs');
cpSync(keyringDir, join(modules, 'keyring'), { recursive: true, dereference: true });
cpSync(platformDir, join(modules, 'keyring-win32-x64-msvc'), {
  recursive: true,
  dereference: true,
});

console.log(`Staged Node ${process.version}, worker daemon and keyring into ${runtime}`);
```

- [ ] **Step 2: Stage and smoke-test the staged runtime by hand**

Run (Git Bash, from the repo root):

```bash
pnpm build
pnpm --filter @ai-commons/desktop stage
ls apps/desktop/src-tauri/runtime apps/desktop/src-tauri/runtime/daemon/node_modules/@napi-rs
T=$(mktemp -d)
printf '{"id":"1","method":"getStatus"}\n{"id":"2","method":"shutdown"}\n' | \
  AICOMMONS_CONFIG_DIR=$T AICOMMONS_DATA_DIR=$T \
  apps/desktop/src-tauri/runtime/node.exe apps/desktop/src-tauri/runtime/daemon/worker-daemon.mjs
```

Expected:

- `node.exe`, `daemon/worker-daemon.mjs`, `keyring/` and `keyring-win32-x64-msvc/` are present.
- The daemon prints status events and a `{"id":"1","ok":true,…"connection":"unconfigured"…}` line, then exits.
- There is no `Cannot find module '@napi-rs/keyring'`, because keys are checked at startup.

- [ ] **Step 3: Build the installer**

Run: `cd apps/desktop && cargo tauri build`
Expected:

- `src-tauri/target/release/bundle/nsis/AI Commons_0.1.0_x64-setup.exe` is produced.
- Its size is about 30–45 MB.
- On first use, Tauri downloads NSIS itself.

Record the actual size for PROGRESS.md.

- [ ] **Step 4: Commit**

```bash
cd ../..
pnpm format
git add apps/desktop/scripts/stage-runtime.ts
git commit -m "Stage Node runtime, daemon bundle and keyring for the installer" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 20: Manual end-to-end verification (record results)

Use the real stack described in NEXT_STEPS.md. Leave the coordinator running in a separate terminal.

- [ ] **Step 1: Coordinator and demo project**

```bash
docker compose up -d
DATABASE_URL=postgres://aicommons:aicommons@localhost:55432/aicommons_desktop_e2e \
ADMIN_TOKEN=desktop-e2e-token-0123456789abcdef DASHBOARD_DIR=apps/dashboard/dist \
node apps/coordinator/dist/index.js
# other terminal:
cd examples/abstract-classification
COORDINATOR_URL=http://localhost:8080 ADMIN_TOKEN=desktop-e2e-token-0123456789abcdef node scripts/publish.ts data/sample.jsonl
```

Create the `aicommons_desktop_e2e` database first if the coordinator doesn't:

```bash
docker exec aicommons-postgres createdb -U aicommons aicommons_desktop_e2e
```

- [ ] **Step 2: Install and configure**

1. Run the setup exe (per-user install; there's no admin prompt).
2. Launch AI Commons. It should show "Not set up".
3. In Settings:
   - Set the coordinator to `http://localhost:8080`.
   - Enable Ollama, click Detect models, and check `qwen3:4b`. Its context window should be filled in automatically.
   - Save.
4. Make sure Ollama is running at `%LOCALAPPDATA%\Programs\Ollama\ollama.exe`.

- [ ] **Step 3: Verify, noting each result**

1. Status turns Connected, and the current project and task update live. All 20 demo tasks complete; check the dashboard at `http://localhost:8080`.
2. Pause from the window, then from the tray menu. The tooltip reads "Paused", and no new leases appear in the coordinator log. Resume returns to the previous mode.
3. Schedule → "Only while idle", with idle after = 1 minute. Tasks start after about 1–1.25 minutes without input, and stop being leased after you move the mouse (the current task still finishes).
4. Close the window. The app stays in the tray and keeps contributing. Launching it again focuses the existing window instead of starting a second instance.
5. Choose Quit mid-task. The task finishes (or 30 s pass) and `node.exe` disappears from Task Manager.
6. Kill `node.exe` from Task Manager mid-task. The status shows restarting, the worker comes back, and the next start logs "charged stale budget reservations" if a paid call was in flight.
7. Enter a throwaway key (e.g. `sk-test-e2e-not-real-0000`) in the OpenAI key field and save it. Confirm that no plaintext copy of it exists anywhere:

   ```bash
   grep -r "sk-test-e2e-not-real" "$APPDATA/ai-commons" "$LOCALAPPDATA/ai-commons" || echo "not found (good)"
   ```

   Then remove the key with the Remove key button.

8. Clean up: delete the `worker:http://localhost:8080:*` entries (service `ai-commons`) in Windows Credential Manager, and uninstall the app if you want.

- [ ] **Step 4: Record results**

Write the outcomes, including any failures, into PROGRESS.md in Task 21. If any step fails, stop and fix it using superpowers:systematic-debugging before continuing.

---

### Task 21: Documentation and progress

**Files:**

- Create: `docs/desktop.md`
- Modify: `docs/worker.md`, `docs/architecture.md`, `PROGRESS.md`, `NEXT_STEPS.md`

- [ ] **Step 1: Write `docs/desktop.md`**

Cover these sections, each a few short paragraphs or a table. Take the facts from the spec and the code; don't invent any.

1. **What it is:** a Tauri shell plus the Node worker daemon; the no-ports design; why a sidecar (one budget implementation).
2. **Layout:** `apps/desktop/src` (UI), `src-tauri/src/{framing,idle,daemon,supervisor,lib}.rs`, `scripts/stage-runtime.ts`, `apps/worker/src/daemon/*`.
3. **Protocol:** the envelope, the methods table (including `resume`), `DaemonStatus`, the 1 MB line cap, the `setIdle`/`shutdown` shell-only rule, and that params are never logged.
4. **Supervision:** backoff 1/2/4/8 s, giving up at 5 crashes in 5 minutes, Restart, drain-then-kill on Quit, close-to-tray, single instance plus the lock file.
5. **Idle:** `GetLastInputInfo` every 15 s, `idle_after_minutes`, "unknown counts as busy", and that a running task is finished.
6. **Security:** keys go webview → Rust → daemon stdin → keyring; the CSP; capabilities (`core:event:default` only); no shell/fs/http plugins; `REMOTE_DISCLOSURE` gate; `node.exe` launched with `CREATE_NO_WINDOW`.
7. **Build:** `pnpm build` → `pnpm --filter @ai-commons/desktop stage` → `cd apps/desktop && cargo tauri build`; dev mode with `cargo tauri dev` (stage first); `cargo test`.
8. **Limitations:** unsigned (SmartScreen warns); Windows x64 only; no auto-update; no custom schedule windows; CPU/GPU limits not enforced.

- [ ] **Step 2: Update `docs/worker.md`**

- In "Not yet implemented", replace the idle-only bullet with: "Idle-only scheduling requires the desktop app (the CLI has no idle source and refuses it)."
- Add a "Desktop daemon" section that links to `docs/desktop.md` and mentions `bundle:daemon`.
- Add a line under Commands: `start` refuses to run while another worker holds `worker.lock` in the data dir.

- [ ] **Step 3: Update `docs/architecture.md`**

Add `apps/desktop` to the component overview with one paragraph: the Rust shell supervises the worker daemon over stdio, and the webview talks only to Tauri commands.

- [ ] **Step 4: Update PROGRESS.md and NEXT_STEPS.md**

- PROGRESS.md:
  - Mark §68 step 20 ✅ (Phase 8).
  - Update the test counts from actual `pnpm test` output, plus the `cargo test` count.
  - Add the desktop row to "What exists".
  - Add the Task 20 e2e results and the installer size.
  - Move the fixed items out of "Known gaps": idle_only, the single-instance lock, and `context_window` auto-fill (via Detect models).
  - Add new gaps: unsigned installer, no auto-update, no CI desktop job, Windows-only packaging.
- NEXT_STEPS.md:
  - Remove option A.
  - Keep B and C.
  - Add small follow-ups: code signing, a CI `windows-latest` job running `cargo test` and `cargo tauri build`, and auto-update.

- [ ] **Step 5: Full verification, then commit**

Run:

```bash
pnpm format && pnpm format:check && pnpm lint && pnpm typecheck && pnpm test
cd apps/desktop/src-tauri && cargo test && cargo clippy -- -D warnings
```

Expected: everything passes. Coordinator tests need Docker Postgres.

```bash
cd ../../..
git add docs PROGRESS.md NEXT_STEPS.md
git commit -m "Document the desktop worker and update progress" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Finish the branch**

Use superpowers:finishing-a-development-branch. The repo has no remote yet, so the expected choice is a local merge into `main`.

---

## Spec coverage checklist

| Spec requirement                                                 | Task        |
| ---------------------------------------------------------------- | ----------- |
| Node daemon over stdio, no ports                                 | 6, 7, 8, 16 |
| Bundled node.exe + daemon + keyring as resources                 | 8, 13, 19   |
| `isIdle`, idle_only in runner; CLI still refuses                 | 3           |
| `idle_after_minutes` config                                      | 1           |
| Lock shared by daemon and CLI                                    | 2, 7        |
| All protocol methods incl. `resume`; 1 MB cap; bad lines survive | 6, 7        |
| `DaemonStatus` fields                                            | 4, 6, 7     |
| Keys never echoed/logged/persisted                               | 7, 11, 18   |
| `probeProvider` fills `context_window`                           | 7, 11       |
| Supervisor restart/backoff/give-up, Restart button               | 17, 10, 12  |
| Quit drains 30 s then kills; stdin EOF shuts down                | 7, 17, 18   |
| Close to tray; tray Open/Pause/Resume/Quit; tooltip              | 17, 18      |
| `GetLastInputInfo` poller, change-only `setIdle`                 | 15, 18      |
| Single-instance plugin                                           | 18          |
| §35 status screen, meters amber at 80%                           | 10          |
| §36 settings incl. disclosure gate, disabled CPU/GPU fields      | 11          |
| CSP, minimal capabilities, allow-listed methods                  | 13, 18      |
| Unsigned NSIS installer                                          | 19          |
| Tests: worker, UI, Rust; manual e2e                              | all, 20     |
| Docs                                                             | 21          |
