import type { DaemonStatus, ProviderStatus } from '@ai-commons/worker';
import { h, type Child } from './dom.js';
import { fmtInt, fmtUsd } from './format.js';
import type { SupervisorState } from './ipc.js';

export type Tone = 'ok' | 'warn' | 'danger' | 'neutral';

export interface StatusActions {
  onTogglePause: () => void;
  onRestart: () => void;
}

export function connectionLabel(s: DaemonStatus): { text: string; tone: Tone } {
  if (s.connection === 'unconfigured') return { text: 'Not set up', tone: 'neutral' };
  if (s.connection === 'offline') return { text: 'Offline', tone: 'danger' };
  if (s.connection === 'connecting') return { text: 'Connecting…', tone: 'warn' };
  if (s.mode === 'paused') return { text: 'Paused', tone: 'neutral' };
  if (s.mode === 'idle_only' && !s.idle) return { text: 'Waiting for idle', tone: 'neutral' };
  return { text: 'Connected', tone: 'ok' };
}

function row(label: string, value: Child): HTMLElement {
  return h(
    'div',
    { class: 'row' },
    h('span', { class: 'label' }, label),
    h('span', { class: 'value' }, value),
  );
}

function button(
  label: string,
  action: string,
  onClick: () => void,
  cls = 'secondary',
): HTMLButtonElement {
  const el = h(
    'button',
    { type: 'button', class: cls, 'data-action': action, 'data-key': action },
    label,
  );
  el.addEventListener('click', onClick);
  return el;
}

function meter(label: string, spent: number, limit: number): HTMLElement {
  if (!Number.isFinite(limit) || limit <= 0) return row(label, 'No paid calls ($0 limit)');
  const raw = spent / limit;
  const pct = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw * 100)) : 0;
  const fill = h('span', { class: 'fill' });
  fill.style.width = `${pct}%`;
  const cls = pct >= 100 ? 'meter danger' : pct >= 80 ? 'meter warn' : 'meter';
  const bar = h(
    'div',
    {
      class: cls,
      role: 'meter',
      'aria-label': label,
      'aria-valuemin': 0,
      'aria-valuemax': 100,
      'aria-valuenow': Math.round(pct),
      'aria-valuetext': `${fmtUsd(spent)} of ${fmtUsd(limit)}`,
    },
    fill,
  );
  return h('div', {}, row(label, `${fmtUsd(spent)} / ${fmtUsd(limit)}`), bar);
}

function providerState(p: ProviderStatus): string {
  if (!p.enabled) return 'Disabled';
  if (p.requires_key && !p.has_key) return 'Enabled · no API key';
  if (p.healthy === false) return 'Enabled · unavailable';
  return 'Enabled';
}

function banner(s: DaemonStatus, sup: SupervisorState, actions: StatusActions): HTMLElement | null {
  if (sup.state === 'restarting') {
    return h(
      'div',
      { class: 'banner warn', role: 'status' },
      sup.message ?? 'Restarting the worker…',
    );
  }
  if (sup.state === 'stopped') {
    return h(
      'div',
      { class: 'banner danger', role: 'alert' },
      h('span', {}, `Worker stopped: ${sup.message ?? 'unknown error'}`),
      button('Restart', 'restart', actions.onRestart),
    );
  }
  if (s.last_error) return h('div', { class: 'banner warn', role: 'status' }, s.last_error);
  return null;
}

export function renderStatus(
  s: DaemonStatus,
  sup: SupervisorState,
  actions: StatusActions,
  notice?: string,
): HTMLElement {
  const conn = connectionLabel(s);
  const current = s.current;
  return h(
    'div',
    { class: 'status-view' },
    banner(s, sup, actions),
    notice ? h('div', { class: 'banner danger', role: 'alert' }, notice) : null,
    h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Status'),
      h('p', {}, h('span', { class: `pill ${conn.tone}`, 'data-live': 'connection' }, conn.text)),
      row('Current project', current ? (current.project_name ?? current.project_id) : '—'),
      row('Current task', current ? `#${current.task_id}` : '—'),
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Contribution today'),
      row('Tasks', fmtInt(s.today.tasks_submitted)),
      row('Tokens', fmtInt(s.today.input_tokens + s.today.output_tokens)),
      row('API cost', fmtUsd(s.today.api_cost_usd)),
      h(
        'p',
        { class: 'muted' },
        `This month: ${fmtInt(s.month.tasks_submitted)} tasks · ${fmtUsd(s.month.api_cost_usd)}`,
      ),
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Resources'),
      ...s.providers.map((p) => row(p.display_name, providerState(p))),
      meter('Daily API limit', s.today.api_cost_usd, s.limits.daily_usd),
      meter('Monthly API limit', s.month.api_cost_usd, s.limits.monthly_usd),
    ),
    button(
      s.mode === 'paused' ? 'Resume contributions' : 'Pause contributions',
      'toggle-pause',
      actions.onTogglePause,
      'primary',
    ),
  );
}
