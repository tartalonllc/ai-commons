import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  ModelCapability,
  parse,
  ProjectCategory,
  ProjectId,
  ProviderId,
  ProviderKind,
  WorkerId,
} from '@ai-commons/protocol';
import Type, { type Static } from 'typebox';

export const ScheduleMode = Type.Union([
  Type.Literal('active'),
  Type.Literal('paused'),
  Type.Literal('idle_only'),
]);
export type ScheduleMode = Static<typeof ScheduleMode>;

/** Non-secret provider settings. API keys live only in the OS keyring. */
export const ProviderConfig = Type.Object(
  {
    id: ProviderId,
    kind: ProviderKind,
    enabled: Type.Boolean(),
    models: Type.Array(ModelCapability, { maxItems: 64 }),
    endpoint: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
    /** USD per 1M tokens, overriding adapter defaults. */
    pricing: Type.Optional(
      Type.Record(
        Type.String(),
        Type.Object(
          {
            input_per_mtok: Type.Number({ minimum: 0 }),
            output_per_mtok: Type.Number({ minimum: 0 }),
          },
          { additionalProperties: false },
        ),
      ),
    ),
  },
  { additionalProperties: false },
);
export type ProviderConfig = Static<typeof ProviderConfig>;

export const WorkerConfig = Type.Object(
  {
    version: Type.Literal(1),
    coordinator_url: Type.String({ minLength: 1, maxLength: 2048 }),
    worker_id: Type.Optional(WorkerId),
    providers: Type.Array(ProviderConfig, { maxItems: 16 }),
    limits: Type.Object(
      {
        api: Type.Object(
          {
            daily_usd: Type.Number({ minimum: 0, maximum: 10_000 }),
            monthly_usd: Type.Number({ minimum: 0, maximum: 100_000 }),
          },
          { additionalProperties: false },
        ),
        local: Type.Object(
          {
            cpu_percent: Type.Integer({ minimum: 1, maximum: 100 }),
            gpu_percent: Type.Integer({ minimum: 0, maximum: 100 }),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    schedule: Type.Object({ mode: ScheduleMode }, { additionalProperties: false }),
    projects: Type.Object(
      {
        categories: Type.Union([
          Type.Literal('all'),
          Type.Array(ProjectCategory, { minItems: 1, maxItems: 16 }),
        ]),
        /** Projects whose data may be sent to remote (commercial) providers (§53). */
        allow_remote_for_projects: Type.Union([
          Type.Literal('all'),
          Type.Array(ProjectId, { maxItems: 256 }),
        ]),
      },
      { additionalProperties: false },
    ),
    log_level: Type.Union([
      Type.Literal('debug'),
      Type.Literal('info'),
      Type.Literal('warn'),
      Type.Literal('error'),
    ]),
  },
  { additionalProperties: false },
);
export type WorkerConfig = Static<typeof WorkerConfig>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function defaultConfig(): WorkerConfig {
  return {
    version: 1,
    coordinator_url: 'http://localhost:3000',
    providers: [
      {
        id: 'ollama',
        kind: 'local',
        enabled: true,
        models: [],
        endpoint: 'http://localhost:11434',
      },
    ],
    limits: {
      api: { daily_usd: 0, monthly_usd: 0 },
      local: { cpu_percent: 25, gpu_percent: 50 },
    },
    schedule: { mode: 'active' },
    projects: { categories: 'all', allow_remote_for_projects: [] },
    log_level: 'info',
  };
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Coordinator traffic must use TLS except to the local machine (§41). */
export function validateCoordinatorUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`Invalid coordinator URL: ${raw}`);
  }
  if (url.username || url.password) {
    throw new ConfigError('Coordinator URL must not contain credentials');
  }
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)) return url;
  throw new ConfigError(
    'Coordinator URL must use https:// (plain http is allowed only for localhost)',
  );
}

export function validateConfig(input: unknown): WorkerConfig {
  const result = parse(WorkerConfig, input);
  if (!result.ok) {
    const details = result.issues.map((i) => `${i.path}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid worker config: ${details}`);
  }
  const config = result.value;
  validateCoordinatorUrl(config.coordinator_url);
  if (config.limits.api.daily_usd > config.limits.api.monthly_usd) {
    throw new ConfigError('Daily API limit cannot exceed the monthly API limit');
  }
  const ids = config.providers.map((p) => p.id);
  if (new Set(ids).size !== ids.length) throw new ConfigError('Duplicate provider ids in config');
  return config;
}

export async function loadConfig(file: string): Promise<WorkerConfig> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultConfig();
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ConfigError(`Config file is not valid JSON: ${file}`);
  }
  return validateConfig(json);
}

export async function configExists(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

/** Atomic write (temp file + rename), owner-only permissions where supported. */
export async function saveConfig(file: string, config: WorkerConfig): Promise<void> {
  const valid = validateConfig(config);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(valid, null, 2)}\n`, { mode: 0o600 });
  // Windows refuses to replace a file another process has open (e.g. a running worker reading it).
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, file);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') || attempt >= 20) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

export function remoteAllowedFor(config: WorkerConfig, projectId: string): boolean {
  const allow = config.projects.allow_remote_for_projects;
  return allow === 'all' || allow.includes(projectId);
}
