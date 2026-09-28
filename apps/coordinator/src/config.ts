import { LIMITS } from '@ai-commons/protocol';

export interface CoordinatorConfig {
  databaseUrl: string;
  adminToken: string;
  port: number;
  host: string;
  leaseDurationMs: number;
  heartbeatIntervalMs: number;
  /** Failures (across workers) before a task is marked FAILED. */
  maxTaskFailures: number;
  rateLimit: { max: number; registerMaxPerHour: number } | false;
  logLevel: string;
  /** Built dashboard (apps/dashboard/dist) to serve at `/`; disabled when undefined. */
  dashboardDir: string | undefined;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

function intFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0)
    throw new ConfigError(`${key} must be a non-negative integer`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CoordinatorConfig {
  const databaseUrl = env['DATABASE_URL'];
  if (!databaseUrl || !/^postgres(ql)?:\/\//.test(databaseUrl)) {
    throw new ConfigError('DATABASE_URL must be a postgres:// connection string');
  }
  const adminToken = env['ADMIN_TOKEN'];
  if (!adminToken || adminToken.length < 24) {
    throw new ConfigError('ADMIN_TOKEN must be set and at least 24 characters');
  }
  const port = intFromEnv(env, 'PORT', 8080);
  if (port < 1 || port > 65_535) throw new ConfigError('PORT must be between 1 and 65535');

  return {
    databaseUrl,
    adminToken,
    port,
    host: env['HOST'] ?? '0.0.0.0',
    leaseDurationMs: LIMITS.leaseDurationMs,
    heartbeatIntervalMs: LIMITS.heartbeatIntervalMs,
    maxTaskFailures: 3,
    rateLimit:
      env['RATE_LIMIT_DISABLED'] === 'true'
        ? false
        : {
            max: intFromEnv(env, 'RATE_LIMIT_MAX', 300),
            registerMaxPerHour: intFromEnv(env, 'RATE_LIMIT_REGISTER_PER_HOUR', 20),
          },
    logLevel: env['LOG_LEVEL'] ?? 'info',
    dashboardDir: env['DASHBOARD_DIR'] || undefined,
  };
}
