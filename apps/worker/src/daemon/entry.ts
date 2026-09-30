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
