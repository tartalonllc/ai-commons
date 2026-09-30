import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const bundle = fileURLToPath(new URL('../dist-daemon/worker-daemon.mjs', import.meta.url));

describe.skipIf(!existsSync(bundle))('bundled worker daemon', () => {
  it('answers getStatus over stdio and exits 0 on shutdown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aic-bundle-'));
    let child: ChildProcess | undefined;
    let exited = false;
    try {
      child = spawn(process.execPath, [bundle], {
        env: { ...process.env, AICOMMONS_CONFIG_DIR: dir, AICOMMONS_DATA_DIR: dir },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const messages: Record<string, unknown>[] = [];
      const badLines: string[] = [];
      let stderr = '';
      let buffer = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
          const line = buffer.slice(0, i);
          buffer = buffer.slice(i + 1);
          try {
            messages.push(JSON.parse(line) as Record<string, unknown>);
          } catch {
            badLines.push(line);
          }
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      const exitedPromise = new Promise<number | null>((resolve) => {
        child?.on('exit', (code) => {
          exited = true;
          resolve(code);
        });
      });

      child.stdin?.write(`${JSON.stringify({ id: 's1', method: 'getStatus' })}\n`);
      const deadline = Date.now() + 15_000;
      while (!messages.some((m) => m.id === 's1')) {
        if (Date.now() > deadline) {
          throw new Error(`no response from bundled daemon; stderr:\n${stderr}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const reply = messages.find((m) => m.id === 's1') as { result: { connection: string } };
      expect(reply.result.connection).toBe('unconfigured');

      child.stdin?.write(`${JSON.stringify({ id: 's2', method: 'shutdown' })}\n`);
      const exitCode = await exitedPromise;
      expect(exitCode, `daemon exit; stderr:\n${stderr}`).toBe(0);

      const shutdownReply = messages.find((m) => m.id === 's2') as
        { result: { stopping: boolean } } | undefined;
      expect(shutdownReply?.result, `stderr:\n${stderr}`).toEqual({ stopping: true });

      expect(badLines, `unparseable stdout lines; stderr:\n${stderr}`).toEqual([]);
    } finally {
      if (child && !exited) child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
