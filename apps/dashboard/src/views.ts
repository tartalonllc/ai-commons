import {
  LIMITS,
  type NetworkProjectSummary,
  type NetworkSummary,
  type NetworkWorkerSummary,
  type Project,
} from '@ai-commons/protocol';
import { h, type Child } from './dom.js';
import {
  formatCount,
  formatHours,
  formatInteger,
  formatLabel,
  formatPercent,
  formatRelativeTime,
  formatUsd,
} from './format.js';

/** Workers not seen for three heartbeat intervals are shown as offline. */
const OFFLINE_AFTER_MS = 3 * LIMITS.heartbeatIntervalMs;

export const projectHref = (id: string): string => `#/projects/${encodeURIComponent(id)}`;

// ---- Shared pieces --------------------------------------------------------

function stat(label: string, value: string, detail?: string): HTMLElement {
  return h(
    'div',
    { class: 'stat' },
    h('dt', {}, label),
    h('dd', {}, h('span', { class: 'stat-value' }, value), detail && h('small', {}, detail)),
  );
}

export function progressBar(fraction: number, label: string, size: 'sm' | 'lg' = 'sm') {
  const percent = Math.min(1, Math.max(0, fraction)) * 100;
  const fill = h('div', { class: 'progress-fill' });
  // CSSOM writes are permitted under a strict style-src CSP; style attributes are not.
  fill.style.width = `${percent}%`;
  return h(
    'div',
    {
      class: `progress progress-${size}`,
      role: 'progressbar',
      'aria-label': label,
      'aria-valuemin': 0,
      'aria-valuemax': 100,
      'aria-valuenow': Math.floor(percent * 10) / 10,
    },
    fill,
  );
}

function section(title: string, id: string, ...children: Child[]): HTMLElement {
  const headingId = `${id}-heading`;
  return h(
    'section',
    { class: 'section', 'aria-labelledby': headingId },
    h('h2', { id: headingId }, title),
    ...children,
  );
}

function emptyState(text: string): HTMLElement {
  return h('p', { class: 'empty' }, text);
}

function cell(label: string, ...children: Child[]): HTMLTableCellElement {
  return h('td', { 'data-label': label }, ...children);
}

// ---- Overview -------------------------------------------------------------

function projectsTable(projects: readonly NetworkProjectSummary[]): HTMLElement {
  if (projects.length === 0) return emptyState('No projects have been published yet.');
  return h(
    'table',
    { class: 'table' },
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        h('th', { scope: 'col' }, 'Project'),
        h('th', { scope: 'col', class: 'col-progress' }, 'Progress'),
        h('th', { scope: 'col', class: 'num' }, 'Tasks complete'),
        h('th', { scope: 'col', class: 'num' }, 'Workers'),
      ),
    ),
    h(
      'tbody',
      {},
      ...projects.map((p) =>
        h(
          'tr',
          {},
          cell(
            'Project',
            h('a', { href: projectHref(p.id), 'data-key': `project:${p.id}` }, p.name),
          ),
          cell(
            'Progress',
            h(
              'div',
              { class: 'progress-cell' },
              progressBar(p.progress, `${p.name} progress`),
              h('span', { class: 'progress-text' }, formatPercent(p.progress)),
            ),
          ),
          h(
            'td',
            { 'data-label': 'Tasks complete', class: 'num' },
            `${formatInteger(p.tasks_completed)} / ${formatInteger(p.tasks_total)}`,
          ),
          h('td', { 'data-label': 'Workers', class: 'num' }, formatInteger(p.workers)),
        ),
      ),
    ),
  );
}

export function workerStatus(
  worker: NetworkWorkerSummary,
  now: Date,
): 'available' | 'busy' | 'paused' | 'offline' {
  const age = now.getTime() - new Date(worker.last_seen).getTime();
  return age > OFFLINE_AFTER_MS ? 'offline' : worker.status;
}

function workersTable(workers: readonly NetworkWorkerSummary[], now: Date): HTMLElement {
  if (workers.length === 0) return emptyState('No workers have connected yet.');
  return h(
    'table',
    { class: 'table' },
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        h('th', { scope: 'col' }, 'Worker'),
        h('th', { scope: 'col' }, 'Status'),
        h('th', { scope: 'col', class: 'num' }, 'Tasks'),
        h('th', { scope: 'col', class: 'num' }, 'Last seen'),
      ),
    ),
    h(
      'tbody',
      {},
      ...workers.map((w) => {
        const status = workerStatus(w, now);
        return h(
          'tr',
          {},
          cell('Worker', h('code', {}, w.worker_id)),
          cell('Status', h('span', { class: `pill pill-${status}` }, formatLabel(status))),
          h('td', { 'data-label': 'Tasks', class: 'num' }, formatInteger(w.tasks_completed)),
          h(
            'td',
            { 'data-label': 'Last seen', class: 'num' },
            h('time', { datetime: w.last_seen }, formatRelativeTime(w.last_seen, now)),
          ),
        );
      }),
    ),
  );
}

export function renderOverview(summary: NetworkSummary, now: Date): HTMLElement {
  const { network: n, compute: c } = summary;
  const tokens = c.input_tokens + c.output_tokens;
  return h(
    'div',
    { class: 'view' },
    h(
      'header',
      { class: 'page-header' },
      h('h1', {}, 'Network'),
      h(
        'p',
        { class: 'lede' },
        'Volunteers contributing local and API-based AI inference to public-good projects.',
      ),
    ),
    h(
      'dl',
      { class: 'stats' },
      stat('Connected workers', formatInteger(n.connected_workers)),
      stat('Active workers', formatInteger(n.active_workers)),
      stat('Tasks waiting', formatCount(n.tasks_waiting)),
      stat('Tasks processing', formatCount(n.tasks_processing)),
      stat('Tasks completed', formatCount(n.tasks_completed)),
      stat('Tasks failed', formatCount(n.tasks_failed)),
    ),
    section(
      'Compute donated',
      'compute',
      h(
        'dl',
        { class: 'stats stats-3' },
        stat(
          'Tokens processed',
          formatCount(tokens),
          `${formatCount(c.input_tokens)} in · ${formatCount(c.output_tokens)} out`,
        ),
        stat('Local inference', formatHours(c.local_inference_hours), 'on volunteer hardware'),
        stat(
          'API compute donated',
          formatUsd(c.api_cost_usd),
          `${formatInteger(Math.round(c.ai_compute_units))} AI Compute Units`,
        ),
      ),
    ),
    section('Projects', 'projects', projectsTable(summary.projects)),
    section(
      'Workers',
      'workers',
      workersTable(summary.workers, now),
      h(
        'p',
        { class: 'note' },
        'Worker IDs are random and reveal nothing about the volunteer or their machine. ' +
          'Showing up to 100 most recently seen workers.',
      ),
    ),
  );
}

// ---- Public project page --------------------------------------------------

function definitionList(entries: readonly [string, Child][]): HTMLElement {
  return h(
    'dl',
    { class: 'facts' },
    ...entries.map(([term, value]) => h('div', {}, h('dt', {}, term), h('dd', {}, value))),
  );
}

function codeBlock(label: string, text: string): HTMLElement {
  return h(
    'figure',
    { class: 'code' },
    h('figcaption', {}, label),
    h('pre', { tabindex: 0 }, h('code', {}, text)),
  );
}

export function renderProjectPage(
  project: Project,
  summary: NetworkProjectSummary | undefined,
  now: Date,
): HTMLElement {
  const req = project.requirements;
  const validation = project.validation;
  const progress = summary?.progress ?? 0;

  const hero = h(
    'section',
    { class: 'hero', 'aria-label': 'Progress' },
    h(
      'div',
      { class: 'hero-top' },
      h('span', { class: 'hero-percent' }, summary ? formatPercent(progress) : '—'),
      h(
        'span',
        { class: 'hero-count' },
        summary
          ? `${formatInteger(summary.tasks_completed)} / ${formatInteger(summary.tasks_total)} tasks`
          : 'Progress unavailable',
      ),
    ),
    progressBar(progress, `${project.name} progress`, 'lg'),
    // Local inference is reported separately rather than priced: there is no
    // defensible USD normalization for volunteer hardware yet (spec §26).
    h(
      'dl',
      { class: 'stats' },
      stat('Contributors', summary ? formatInteger(summary.workers) : '—'),
      stat('Tokens processed', summary ? formatCount(summary.tokens_processed) : '—'),
      stat(
        'Local inference',
        summary ? formatHours(summary.local_inference_hours) : '—',
        'on volunteer hardware',
      ),
      stat(
        'API compute donated',
        summary ? formatUsd(summary.api_cost_usd) : '—',
        'paid AI API usage',
      ),
    ),
  );

  const consensus =
    validation.mode === 'consensus' && validation.consensus_fields?.length
      ? ` on ${validation.consensus_fields.join(', ')}`
      : '';

  return h(
    'div',
    { class: 'view' },
    h('a', { class: 'back', href: '#/', 'data-key': 'back' }, '← All projects'),
    h(
      'header',
      { class: 'page-header' },
      h(
        'p',
        { class: 'eyebrow' },
        h('span', { class: 'pill pill-category' }, formatLabel(project.category)),
        ` v${project.version}`,
        project.status === 'active' ? null : ` · ${formatLabel(project.status)}`,
      ),
      h('h1', {}, project.name),
    ),
    section('Goal', 'goal', h('p', { class: 'goal' }, project.description || 'No description.')),
    hero,
    section(
      'What volunteers run',
      'transparency',
      h(
        'p',
        { class: 'note' },
        'Workers fill this template with each task and send it to the model they chose. ' +
          'No code from this project runs on volunteer machines, and nothing else is added.',
      ),
      definitionList([
        ['Capability', formatLabel(req.capability)],
        ['Minimum context window', `${formatInteger(req.minimum_context_window)} tokens`],
        ['Maximum output', `${formatInteger(req.max_output_tokens)} tokens per task`],
        [
          'Local models only',
          req.local_models_only
            ? 'Yes: task data never leaves volunteer machines'
            : 'No: volunteers may opt in to commercial AI APIs',
        ],
        [
          'Validation',
          `${formatLabel(validation.mode)}, ${formatInteger(validation.replication_factor)} ` +
            `independent ${validation.replication_factor === 1 ? 'result' : 'results'}${consensus}`,
        ],
        ['Last updated', formatRelativeTime(project.updated_at, now)],
      ]),
      codeBlock('System prompt', project.prompt.system || '(empty)'),
      codeBlock('User prompt template', project.prompt.user),
      codeBlock('Output schema', JSON.stringify(project.output_schema, null, 2)),
      codeBlock('Input schema', JSON.stringify(project.input_schema, null, 2)),
    ),
  );
}

export function renderMessage(title: string, text: string, backLink = false): HTMLElement {
  return h(
    'div',
    { class: 'view message' },
    backLink && h('a', { class: 'back', href: '#/', 'data-key': 'back' }, '← All projects'),
    h('h1', {}, title),
    h('p', {}, text),
  );
}
