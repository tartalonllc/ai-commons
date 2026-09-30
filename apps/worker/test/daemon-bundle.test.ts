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
