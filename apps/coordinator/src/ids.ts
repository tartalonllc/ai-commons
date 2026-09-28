import { randomBytes } from 'node:crypto';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Unbiased random string: rejection sampling over random bytes. */
function randomString(alphabet: string, length: number): string {
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < limit) out += alphabet[byte % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
}

export const newWorkerId = (): string => `worker_${randomString(BASE32, 16)}`;
export const newWorkerSecret = (): string => randomBytes(32).toString('base64url');
export const newTaskId = (): string => `task_${randomString(BASE32, 20)}`;
export const newLeaseId = (): string => `lease_${randomString(ALNUM, 24)}`;
export const newRowId = (prefix: string): string => `${prefix}_${randomString(BASE32, 20)}`;
