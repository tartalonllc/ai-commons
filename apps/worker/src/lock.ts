// apps/worker/src/lock.ts
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { uptime } from 'node:os';
import { join } from 'node:path';

export const LOCK_FILE = 'worker.lock';

export class LockHeldError extends Error {
  constructor(
    readonly pid: number,
    readonly file: string,
  ) {
    super(
      `Another AI Commons worker is already running (process ${pid}). Stop it before starting a new one. If no worker is running, delete ${file}.`,
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

const PID_PATTERN = /^\d+$/;

function readHolder(file: string): number | undefined {
  try {
    const text = readFileSync(file, 'utf8').trim();
    if (!PID_PATTERN.test(text)) return undefined;
    const pid = Number.parseInt(text, 10);
    return pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** True if the lock file predates the current boot, so any PID it names has been recycled. */
function predatesBoot(file: string, bootTime: number): boolean {
  try {
    return statSync(file).mtimeMs < bootTime;
  } catch {
    return false;
  }
}

function unlinkIfExists(file: string): void {
  try {
    unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * One contributing worker per data directory, shared by the desktop daemon and
 * `aicommons start`. A lock left by a crashed process (dead PID, unreadable
 * content, or a PID recycled since the last boot) is reclaimed. Budget safety
 * does not depend on this lock (reservations are transactional); it prevents
 * double contribution and duplicate heartbeats.
 */
export function acquireInstanceLock(
  dataDir: string,
  options: { pid?: number; alive?: (pid: number) => boolean; bootTime?: number } = {},
): InstanceLock {
  const pid = options.pid ?? process.pid;
  const alive = options.alive ?? processAlive;
  const bootTime = options.bootTime ?? Date.now() - uptime() * 1000;
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, LOCK_FILE);

  for (let attempt = 0; attempt < 3; attempt++) {
    const tmp = join(dataDir, `${LOCK_FILE}.${pid}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      const fd = openSync(tmp, 'w');
      try {
        writeSync(fd, String(pid));
      } finally {
        closeSync(fd);
      }
      try {
        // Hard-linking the fully-written temp file into place is atomic: the lock
        // file never exists without its PID already in it, and this throws EEXIST
        // if another holder is already there.
        linkSync(tmp, file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const holder = readHolder(file);
        if (holder !== undefined && !predatesBoot(file, bootTime) && alive(holder)) {
          throw new LockHeldError(holder, file);
        }
        // Re-read right before reclaiming: if the holder changed since we evaluated
        // it (another process reclaimed or renewed it first), re-evaluate from scratch
        // instead of deleting a lock that is no longer the one we inspected.
        if (readHolder(file) !== holder) continue;
        unlinkIfExists(file);
        continue;
      }
    } finally {
      // Best-effort: a stray `.tmp` file is harmless, and a failure here must
      // never mask the real outcome of the link attempt above.
      try {
        unlinkIfExists(tmp);
      } catch {
        // ignore
      }
    }

    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        if (readHolder(file) !== pid) return;
        unlinkIfExists(file);
      },
    };
  }
  throw new Error(`Could not acquire the worker lock at ${file}`);
}
