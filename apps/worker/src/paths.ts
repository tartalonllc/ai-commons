import { homedir } from 'node:os';
import { join } from 'node:path';

const APP_DIR = 'ai-commons';

export interface WorkerPaths {
  configDir: string;
  dataDir: string;
  configFile: string;
  databaseFile: string;
  logFile: string;
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

function defaultConfigDir(): string {
  switch (process.platform) {
    case 'win32':
      return join(env('APPDATA') ?? join(homedir(), 'AppData', 'Roaming'), APP_DIR);
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', APP_DIR);
    default:
      return join(env('XDG_CONFIG_HOME') ?? join(homedir(), '.config'), APP_DIR);
  }
}

function defaultDataDir(): string {
  switch (process.platform) {
    case 'win32':
      return join(env('LOCALAPPDATA') ?? join(homedir(), 'AppData', 'Local'), APP_DIR);
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', APP_DIR);
    default:
      return join(env('XDG_DATA_HOME') ?? join(homedir(), '.local', 'share'), APP_DIR);
  }
}

/** `AICOMMONS_CONFIG_DIR` / `AICOMMONS_DATA_DIR` override the OS defaults. */
export function resolvePaths(): WorkerPaths {
  const configDir = env('AICOMMONS_CONFIG_DIR') ?? defaultConfigDir();
  const dataDir = env('AICOMMONS_DATA_DIR') ?? defaultDataDir();
  return {
    configDir,
    dataDir,
    configFile: join(configDir, 'config.json'),
    databaseFile: join(dataDir, 'worker.db'),
    logFile: join(dataDir, 'worker.log'),
  };
}
