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
