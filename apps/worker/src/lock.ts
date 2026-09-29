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
