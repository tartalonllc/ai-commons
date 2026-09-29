// apps/worker/test/lock.test.ts
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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

  it('treats trailing-garbage content as unparseable and reclaims it', () => {
    writeFileSync(join(dir, LOCK_FILE), '123abc');
    const lock = acquireInstanceLock(dir, { pid: 9, alive: () => true });
    expect(lockText()).toBe('9');
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

  it('detects an exited child process as not alive', async () => {
    const child = spawn(process.execPath, ['-e', '']);
    const pid = child.pid;
    if (pid === undefined) throw new Error('spawn did not allocate a pid');
    await new Promise((resolve) => child.on('exit', resolve));
    expect(processAlive(pid)).toBe(false);
  });

  it('reclaims a lock whose mtime predates the system boot time, even if the pid is alive', () => {
    writeFileSync(join(dir, LOCK_FILE), '111');
    const past = Date.now() - 60_000;
    utimesSync(join(dir, LOCK_FILE), new Date(past), new Date(past));
    const lock = acquireInstanceLock(dir, { pid: 222, alive: () => true, bootTime: Date.now() });
    expect(lockText()).toBe('222');
    lock.release();
  });

  it('names the lock file path in the error, with instructions to delete it', () => {
    acquireInstanceLock(dir, { pid: 111, alive: () => true });
    expect(() => acquireInstanceLock(dir, { pid: 222, alive: () => true })).toThrow(
      join(dir, LOCK_FILE),
    );
    expect(() => acquireInstanceLock(dir, { pid: 222, alive: () => true })).toThrow(
      /delete .*worker\.lock/,
    );
  });
});
