import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { ProjectCategory, parse, ProjectId } from '@ai-commons/protocol';
import {
  ConfigError,
  loadConfig,
  saveConfig,
  validateConfig,
  type ProviderConfig,
  type WorkerConfig,
} from './config.js';
import { CoordinatorClient, type FetchFn } from './coordinator-client.js';
import { WorkerDatabase } from './db.js';
import { createFileAndStderrLogger, type Logger } from './logger.js';
import type { WorkerPaths } from './paths.js';
import { builtinProviders } from './providers/builtin.js';
import type { ProviderRegistry } from './providers/registry.js';
import { WorkerRunner } from './runner.js';
import { KeyringSecretStore, secretAccounts, type SecretStore } from './secrets.js';
import { localTotals } from './stats.js';
import { BudgetLimiter } from './budget.js';

export interface CliIO {
  out: (line: string) => void;
  err: (line: string) => void;
  stdin: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
  stdout: NodeJS.WritableStream;
}

export interface CliContext {
  paths: WorkerPaths;
  io: CliIO;
  secrets?: SecretStore;
  registry?: ProviderRegistry;
  fetch?: FetchFn;
  logger?: Logger;
  /** Installs signal handlers for `start`; tests pass a no-op. */
  onSignal?: (handler: () => void) => void;
}

export const REMOTE_DISCLOSURE =
  'Note: remote providers receive the full task input for every task they process. ' +
  'Only projects you allow will ever be sent to a remote provider, and projects marked ' +
  'local_models_only are never sent.';

const HELP = `AI Commons worker

Usage: aicommons <command> [options]

Commands:
  configure            Set coordinator, providers, limits, and project preferences
  status               Show connection, today's contribution, and limits
  start                Start contributing (Ctrl+C once to finish the current task, twice to cancel)
  pause                Pause contributions (takes effect in a running worker)
  resume               Resume contributions
  set-key <provider>   Store a provider API key in the OS credential store (read from prompt/stdin)
  usage                Show API spend and contribution totals
  inspect <project>    Show a project's description, prompt, output schema, and requirements
  help                 Show this help

configure options:
  --coordinator-url <url>    --daily-usd <n>          --monthly-usd <n>
  --cpu-percent <n>          --gpu-percent <n>        --mode active|paused
  --enable <provider>        --disable <provider>     (repeatable)
  --models <provider>=<m1,m2> (repeatable)            --categories all|<c1,c2>
  --allow-remote all|none|<project1,project2>        --non-interactive`;

function fmtUsd(n: number): string {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function numberFlag(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new ConfigError(`--${name} must be a number`);
  return n;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}

/** Reads a secret without echoing it. Falls back to piped stdin when not a TTY. */
export async function readSecret(io: CliIO, prompt: string): Promise<string> {
  const { stdin } = io;
  if (!stdin.isTTY || !stdin.setRawMode) return (await readAll(stdin)).trim();
  io.stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = '';
    const onData = (data: Buffer | string) => {
      for (const ch of data.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          io.stdout.write('\n');
          resolve(value.trim());
          return;
        }
        if (ch === '\u0003') {
          cleanup();
          reject(new Error('cancelled'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode?.(false);
      stdin.pause();
    };
    stdin.on('data', onData);
  });
}

function applyConfigureFlags(
  config: WorkerConfig,
  values: Record<string, string | boolean | string[] | undefined>,
  registry: ProviderRegistry,
): WorkerConfig {
  const next: WorkerConfig = structuredClone(config);
  const str = (k: string) => (typeof values[k] === 'string' ? (values[k] as string) : undefined);
  const list = (k: string) => (Array.isArray(values[k]) ? (values[k] as string[]) : []);

  const url = str('coordinator-url');
  if (url !== undefined) next.coordinator_url = url;
  const daily = numberFlag('daily-usd', str('daily-usd'));
  if (daily !== undefined) next.limits.api.daily_usd = daily;
  const monthly = numberFlag('monthly-usd', str('monthly-usd'));
  if (monthly !== undefined) next.limits.api.monthly_usd = monthly;
  const cpu = numberFlag('cpu-percent', str('cpu-percent'));
  if (cpu !== undefined) next.limits.local.cpu_percent = cpu;
  const gpu = numberFlag('gpu-percent', str('gpu-percent'));
  if (gpu !== undefined) next.limits.local.gpu_percent = gpu;
  const mode = str('mode');
  if (mode !== undefined) {
    if (mode !== 'active' && mode !== 'paused')
      throw new ConfigError('--mode must be active or paused');
    next.schedule.mode = mode;
  }

  const ensureProvider = (id: string): ProviderConfig => {
    let p = next.providers.find((x) => x.id === id);
    if (!p) {
      const reg = registry.get(id);
      if (!reg)
        throw new ConfigError(
          `Unknown provider "${id}". Known: ${registry
            .list()
            .map((r) => r.id)
            .join(', ')}`,
        );
      p = {
        id,
        kind: reg.kind,
        enabled: false,
        models: [],
        ...(reg.defaultEndpoint ? { endpoint: reg.defaultEndpoint } : {}),
      };
      next.providers.push(p);
    }
    return p;
  };
  for (const id of list('enable')) ensureProvider(id).enabled = true;
  for (const id of list('disable')) ensureProvider(id).enabled = false;
  for (const spec of list('models')) {
    const eq = spec.indexOf('=');
    if (eq <= 0) throw new ConfigError('--models expects <provider>=<model1,model2>');
    const provider = ensureProvider(spec.slice(0, eq));
    provider.models = spec
      .slice(eq + 1)
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean)
      .map((name) => ({ name }));
  }

  const categories = str('categories');
  if (categories !== undefined) {
    if (categories === 'all') next.projects.categories = 'all';
    else {
      const items = categories.split(',').map((c) => c.trim());
      for (const c of items) {
        if (!parse(ProjectCategory, c).ok) throw new ConfigError(`Unknown category "${c}"`);
      }
      next.projects.categories = items as WorkerConfig['projects']['categories'];
    }
  }
  const allowRemote = str('allow-remote');
  if (allowRemote !== undefined) {
    if (allowRemote === 'all') next.projects.allow_remote_for_projects = 'all';
    else if (allowRemote === 'none') next.projects.allow_remote_for_projects = [];
    else {
      const ids = allowRemote.split(',').map((c) => c.trim());
      for (const id of ids)
        if (!parse(ProjectId, id).ok) throw new ConfigError(`Invalid project id "${id}"`);
      next.projects.allow_remote_for_projects = ids;
    }
  }
  return next;
}

async function interactiveConfigure(
  config: WorkerConfig,
  ctx: CliContext,
  registry: ProviderRegistry,
): Promise<WorkerConfig> {
  const rl = createInterface({ input: ctx.io.stdin, output: ctx.io.stdout });
  const ask = async (q: string, current: string) => {
    const answer = (await rl.question(`${q} [${current}]: `)).trim();
    return answer === '' ? current : answer;
  };
  try {
    const flags: Record<string, string | string[]> = {};
    flags['coordinator-url'] = await ask('Coordinator URL', config.coordinator_url);
    const enable: string[] = [];
    const disable: string[] = [];
    const models: string[] = [];
    for (const reg of registry.list()) {
      const existing = config.providers.find((p) => p.id === reg.id);
      const on = await ask(`Enable ${reg.displayName}? (y/n)`, existing?.enabled ? 'y' : 'n');
      if (on.toLowerCase().startsWith('y')) {
        enable.push(reg.id);
        if (reg.kind === 'remote') ctx.io.out(REMOTE_DISCLOSURE);
        const current = existing?.models.map((m) => m.name).join(',') ?? '';
        const m = await ask(`  Models to allow for ${reg.id} (comma-separated)`, current);
        if (m) models.push(`${reg.id}=${m}`);
      } else disable.push(reg.id);
    }
    flags.enable = enable;
    flags.disable = disable;
    flags.models = models;
    flags['daily-usd'] = await ask('Daily API limit (USD)', String(config.limits.api.daily_usd));
    flags['monthly-usd'] = await ask(
      'Monthly API limit (USD)',
      String(config.limits.api.monthly_usd),
    );
    flags['cpu-percent'] = await ask('CPU limit (%)', String(config.limits.local.cpu_percent));
    flags['gpu-percent'] = await ask('GPU limit (%)', String(config.limits.local.gpu_percent));
    const cats = config.projects.categories;
    flags.categories = await ask(
      'Project categories (all or comma-separated)',
      cats === 'all' ? 'all' : cats.join(','),
    );
    const allow = config.projects.allow_remote_for_projects;
    flags['allow-remote'] = await ask(
      'Projects allowed to use remote providers (all, none, or ids)',
      allow === 'all' ? 'all' : allow.length === 0 ? 'none' : allow.join(','),
    );
    return applyConfigureFlags(config, flags, registry);
  } finally {
    rl.close();
  }
}

export async function runCli(argv: string[], ctx: CliContext): Promise<number> {
  const [command, ...rest] = argv;
  const { io, paths } = ctx;
  const registry = ctx.registry ?? builtinProviders();
  const secrets = (): SecretStore => ctx.secrets ?? new KeyringSecretStore();

  try {
    switch (command) {
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        io.out(HELP);
        return 0;

      case 'configure': {
        const { values } = parseArgs({
          args: rest,
          options: {
            'coordinator-url': { type: 'string' },
            'daily-usd': { type: 'string' },
            'monthly-usd': { type: 'string' },
            'cpu-percent': { type: 'string' },
            'gpu-percent': { type: 'string' },
            mode: { type: 'string' },
            enable: { type: 'string', multiple: true },
            disable: { type: 'string', multiple: true },
            models: { type: 'string', multiple: true },
            categories: { type: 'string' },
            'allow-remote': { type: 'string' },
            'non-interactive': { type: 'boolean' },
          },
          strict: true,
        });
        const current = await loadConfig(paths.configFile);
        const hasFlags = Object.keys(values).some((k) => k !== 'non-interactive');
        const next =
          !hasFlags && !values['non-interactive'] && io.stdin.isTTY
            ? await interactiveConfigure(current, ctx, registry)
            : applyConfigureFlags(current, values, registry);
        validateConfig(next);
        if (next.coordinator_url !== current.coordinator_url) delete next.worker_id;
        await saveConfig(paths.configFile, next);
        const remoteEnabled = next.providers.some((p) => p.enabled && p.kind === 'remote');
        if (remoteEnabled) {
          io.out(REMOTE_DISCLOSURE);
          for (const p of next.providers.filter(
            (x) => x.enabled && registry.get(x.id)?.requiresKey,
          )) {
            if (!(await secrets().get(secretAccounts.provider(p.id)))) {
              io.out(`Provider "${p.id}" needs an API key: run "aicommons set-key ${p.id}".`);
            }
          }
        }
        io.out(`Configuration saved to ${paths.configFile}`);
        return 0;
      }

      case 'pause':
      case 'resume': {
        const config = await loadConfig(paths.configFile);
        config.schedule.mode = command === 'pause' ? 'paused' : 'active';
        await saveConfig(paths.configFile, config);
        io.out(command === 'pause' ? 'Contributions paused.' : 'Contributions resumed.');
        return 0;
      }

      case 'set-key': {
        const { positionals, values } = parseArgs({
          args: rest,
          options: { delete: { type: 'boolean' } },
          allowPositionals: true,
          strict: true,
        });
        const id = positionals[0];
        if (!id || positionals.length > 1) {
          io.err(
            'Usage: aicommons set-key <provider>   (the key is read from a hidden prompt or stdin)',
          );
          return 2;
        }
        const reg = registry.get(id);
        if (!reg) {
          io.err(`Unknown provider "${id}"`);
          return 2;
        }
        if (!reg.requiresKey) {
          io.err(`Provider "${id}" does not use an API key.`);
          return 2;
        }
        const store = secrets();
        if (values.delete) {
          const removed = await store.delete(secretAccounts.provider(id));
          io.out(removed ? `Removed the ${id} key.` : `No ${id} key was stored.`);
          return 0;
        }
        const key = await readSecret(io, `${reg.displayName} API key: `);
        if (key.length < 8 || /\s/.test(key)) {
          io.err('That does not look like a valid API key; nothing was stored.');
          return 2;
        }
        await store.set(secretAccounts.provider(id), key);
        io.out(`Stored the ${id} key in the operating system credential store.`);
        return 0;
      }

      case 'status':
      case 'usage': {
        const config = await loadConfig(paths.configFile);
        const db = new WorkerDatabase(paths.databaseFile);
        try {
          const totals = localTotals(db);
          const spent = new BudgetLimiter(db, () => config.limits.api).spent();
          if (command === 'status') {
            let connection = 'Not registered';
            if (config.worker_id) {
              connection = `Registered as ${config.worker_id}`;
            }
            io.out('AI Commons\n');
            io.out('Status\n--------------------------------');
            io.out(`${connection}`);
            io.out(`Coordinator        ${config.coordinator_url}`);
            io.out(`Mode               ${config.schedule.mode}\n`);
            io.out('Contribution Today\n--------------------------------');
            io.out(`Tasks              ${fmtInt(totals.today.tasks_submitted)}`);
            io.out(
              `Tokens             ${fmtInt(totals.today.input_tokens + totals.today.output_tokens)}`,
            );
            io.out(`API cost           ${fmtUsd(spent.day_usd)}\n`);
            io.out('Resources\n--------------------------------');
            for (const reg of registry.list()) {
              const p = config.providers.find((x) => x.id === reg.id);
              io.out(`${reg.displayName.padEnd(19)}${p?.enabled ? 'Enabled' : 'Disabled'}`);
            }
            io.out('');
            io.out(`Daily API limit    ${fmtUsd(config.limits.api.daily_usd)}`);
            io.out(`Monthly API limit  ${fmtUsd(config.limits.api.monthly_usd)}`);
            io.out(`CPU limit          ${config.limits.local.cpu_percent}% (advisory)`);
            io.out(`GPU limit          ${config.limits.local.gpu_percent}% (advisory)`);
          } else {
            io.out('API spend');
            io.out(
              `  Today        ${fmtUsd(spent.day_usd)} of ${fmtUsd(config.limits.api.daily_usd)}`,
            );
            io.out(
              `  This month   ${fmtUsd(spent.month_usd)} of ${fmtUsd(config.limits.api.monthly_usd)}`,
            );
            for (const [label, t] of [
              ['Today', totals.today],
              ['This month', totals.month],
              ['All time', totals.all_time],
            ] as const) {
              io.out(`\n${label}`);
              io.out(`  Tasks submitted       ${fmtInt(t.tasks_submitted)}`);
              io.out(`  Tasks failed          ${fmtInt(t.tasks_failed)}`);
              io.out(`  Input tokens          ${fmtInt(t.input_tokens)}`);
              io.out(`  Output tokens         ${fmtInt(t.output_tokens)}`);
              io.out(`  Local inference time  ${(t.local_inference_ms / 3_600_000).toFixed(2)} h`);
              io.out(`  API contribution      ${fmtUsd(t.api_cost_usd)}`);
            }
          }
        } finally {
          db.close();
        }
        return 0;
      }

      case 'inspect': {
        const id = rest[0];
        if (!id || !parse(ProjectId, id).ok) {
          io.err('Usage: aicommons inspect <project-id>');
          return 2;
        }
        const config = await loadConfig(paths.configFile);
        const client = new CoordinatorClient({
          baseUrl: config.coordinator_url,
          ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
        });
        const project = await client.getProject(id);
        io.out(`${project.name} (${project.id} v${project.version})`);
        io.out(`Category: ${project.category}    Status: ${project.status}\n`);
        io.out(project.description);
        io.out('\nRequirements');
        io.out(`  Capability            ${project.requirements.capability}`);
        io.out(
          `  Minimum context       ${fmtInt(project.requirements.minimum_context_window)} tokens`,
        );
        io.out(`  Max output tokens     ${fmtInt(project.requirements.max_output_tokens)}`);
        io.out(`  Local models only     ${project.requirements.local_models_only ? 'yes' : 'no'}`);
        io.out(
          `  Validation            ${project.validation.mode} x${project.validation.replication_factor}`,
        );
        io.out('\nSystem prompt\n-------------');
        io.out(project.prompt.system || '(none)');
        io.out('\nUser prompt template\n--------------------');
        io.out(project.prompt.user);
        io.out('\nOutput schema\n-------------');
        io.out(JSON.stringify(project.output_schema, null, 2));
        return 0;
      }

      case 'start': {
        const { values } = parseArgs({
          args: rest,
          options: { 'max-tasks': { type: 'string' } },
          strict: true,
        });
        const maxTasks = numberFlag('max-tasks', values['max-tasks']);
        const config = await loadConfig(paths.configFile);
        const logger = ctx.logger ?? createFileAndStderrLogger(config.log_level, paths.logFile);
        const db = new WorkerDatabase(paths.databaseFile);
        const runner = new WorkerRunner({
          db,
          secrets: secrets(),
          registry,
          logger,
          loadConfig: () => loadConfig(paths.configFile),
          saveConfig: (c) => saveConfig(paths.configFile, c),
          ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
        });
        const install =
          ctx.onSignal ??
          ((handler: () => void) => {
            process.on('SIGINT', handler);
            process.on('SIGTERM', handler);
          });
        install(() => {
          const phase = runner.requestStop();
          io.err(
            phase === 'draining'
              ? 'Finishing the current task before exiting (press Ctrl+C again to cancel it)...'
              : 'Cancelling the current task...',
          );
        });
        try {
          await runner.init();
          io.out(`Contributing as ${runner.workerId ?? 'unknown'}. Press Ctrl+C to stop.`);
          await runner.run(maxTasks === undefined ? {} : { maxTasks });
        } finally {
          db.close();
        }
        return 0;
      }

      default:
        io.err(`Unknown command "${command}". Run "aicommons help".`);
        return 2;
    }
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
