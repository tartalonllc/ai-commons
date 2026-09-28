#!/usr/bin/env node
import { runCli } from './commands.js';
import { resolvePaths } from './paths.js';

process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(process.exitCode ?? 0);
  throw error;
});

const code = await runCli(process.argv.slice(2), {
  paths: resolvePaths(),
  io: {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    stdin: process.stdin,
    stdout: process.stdout,
  },
});
process.exitCode = code;
