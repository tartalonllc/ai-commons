import { describe, expect, it } from 'vitest';
import { replaceContent } from '../src/dom.js';
import { connectionLabel, renderStatus } from '../src/status-view.js';
import { $, idleStatus, status, text } from './fixtures.js';

const running = { state: 'running' } as const;
const noop = { onTogglePause: () => undefined, onRestart: () => undefined };

describe('renderStatus', () => {
  it('shows the §35 screen', () => {
    const t = text(renderStatus(status(), running, noop));
    expect(t).toContain('Connected');
    expect(t).toContain('Current projectOpen Literature Demo');
    expect(t).toContain('Current task#task_014238');
    expect(t).toContain('Tasks238');
    expect(t).toContain('Tokens318,481');
    expect(t).toContain('API cost$0.14');
    expect(t).toContain('This month: 1,200 tasks · $2.10');
    expect(t).toContain('Ollama (local)Enabled');
    expect(t).toContain('OpenAI APIDisabled');
    expect(t).toContain('Daily API limit$0.14 / $0.25');
    expect(t).toContain('Monthly API limit$2.10 / $5.00');
    expect(t).toContain('Pause contributions');
  });

  it('shows dashes when no task is running', () => {
    const t = text(renderStatus(idleStatus(), running, noop));
    expect(t).toContain('Current project—');
    expect(t).toContain('Current task—');
  });

  it('falls back to project_id when project_name is missing', () => {
    const t = text(
      renderStatus(
        status({ current: { project_id: 'proj-only', task_id: 'task_1' } }),
        running,
        noop,
      ),
    );
    expect(t).toContain('Current projectproj-only');
  });

  it('turns the spend meter amber at 80% of the limit', () => {
    const el = renderStatus(
      status({ today: { ...status().today, api_cost_usd: 0.21 } }),
      running,
      noop,
    );
    const daily = $(el, '[role="meter"][aria-label="Daily API limit"]');
    expect(daily.classList.contains('warn')).toBe(true);
    expect(daily.getAttribute('aria-valuenow')).toBe('84');
  });

  it('has no warn or danger class below 80%', () => {
    const el = renderStatus(
      status({ today: { ...status().today, api_cost_usd: 0.05 } }),
      running,
      noop,
    );
    const daily = $(el, '[role="meter"][aria-label="Daily API limit"]');
    expect(daily.classList.contains('warn')).toBe(false);
    expect(daily.classList.contains('danger')).toBe(false);
  });

  it('clamps the meter and turns it red at or above 100%', () => {
    const el = renderStatus(
      status({ today: { ...status().today, api_cost_usd: 5 } }),
      running,
      noop,
    );
    const daily = $(el, '[role="meter"][aria-label="Daily API limit"]');
    expect(daily.classList.contains('danger')).toBe(true);
    expect(daily.getAttribute('aria-valuenow')).toBe('100');
  });

  it('describes the meter value for screen readers', () => {
    const el = renderStatus(status(), running, noop);
    const daily = $(el, '[role="meter"][aria-label="Daily API limit"]');
    expect(daily.getAttribute('aria-valuetext')).toBe('$0.14 of $0.25');
  });

  it('explains a $0 limit instead of drawing a meter', () => {
    const t = text(
      renderStatus(status({ limits: { daily_usd: 0, monthly_usd: 0 } }), running, noop),
    );
    expect(t).toContain('No paid calls ($0 limit)');
  });

  it('treats a non-finite limit as no paid calls', () => {
    const t = text(
      renderStatus(status({ limits: { daily_usd: Infinity, monthly_usd: NaN } }), running, noop),
    );
    expect(t).toContain('No paid calls ($0 limit)');
  });

  it('flags enabled providers that are unavailable or missing a key', () => {
    const providers = status().providers.map((p) =>
      p.id === 'openai' ? { ...p, enabled: true } : { ...p, healthy: false },
    );
    const t = text(renderStatus(status({ providers }), running, noop));
    expect(t).toContain('Ollama (local)Enabled · unavailable');
    expect(t).toContain('OpenAI APIEnabled · no API key');
  });

  it('shows offline errors as text, never HTML', () => {
    const el = renderStatus(
      status({ connection: 'offline', last_error: '<img src=x onerror=alert(1)>' }),
      running,
      noop,
    );
    expect(text(el)).toContain('Offline');
    expect(text(el)).toContain('<img src=x onerror=alert(1)>');
    expect(el.querySelector('img')).toBeNull();
  });

  it('never turns injected text into elements anywhere on the screen', () => {
    const payload = '<img src=x onerror=alert(1)>';
    const providers = status().providers.map((p) => ({ ...p, display_name: payload }));
    const el = renderStatus(
      status({
        current: { project_id: 'p', project_name: payload, task_id: 't' },
        providers,
      }),
      { state: 'restarting', message: payload },
      noop,
      payload,
    );
    expect(el.querySelector('img')).toBeNull();
    const t = text(el);
    expect(t).toContain(payload);
  });

  it('offers Resume when paused', () => {
    const el = renderStatus(status({ mode: 'paused' }), running, noop);
    expect(text(el)).toContain('Paused');
    expect($(el, '[data-action="toggle-pause"]').textContent).toBe('Resume contributions');
  });

  it('shows a restarting banner', () => {
    const el = renderStatus(status(), { state: 'restarting' }, noop);
    expect(text(el)).toContain('Restarting the worker…');
  });

  it('shows a custom restarting message when given', () => {
    const el = renderStatus(status(), { state: 'restarting', message: 'retry 2/5' }, noop);
    expect(text(el)).toContain('retry 2/5');
  });

  it('lets a stopped or restarting banner take priority over last_error', () => {
    const stopped = renderStatus(
      status({ last_error: 'boom' }),
      { state: 'stopped', message: 'exit 1' },
      noop,
    );
    expect(text(stopped)).not.toContain('boom');
    expect(text(stopped)).toContain('Worker stopped: exit 1');

    const restarting = renderStatus(status({ last_error: 'boom' }), { state: 'restarting' }, noop);
    expect(text(restarting)).not.toContain('boom');
  });

  it('calls the handlers', () => {
    let toggled = 0;
    let restarted = 0;
    const el = renderStatus(
      status(),
      { state: 'stopped', message: 'exit code 1' },
      { onTogglePause: () => toggled++, onRestart: () => restarted++ },
    );
    expect(text(el)).toContain('Worker stopped: exit code 1');
    $(el, '[data-action="toggle-pause"]').click();
    $(el, '[data-action="restart"]').click();
    expect([toggled, restarted]).toEqual([1, 1]);
  });

  it('shows an action error passed by the app', () => {
    expect(text(renderStatus(status(), running, noop, 'The worker is not running'))).toContain(
      'The worker is not running',
    );
  });

  it('keeps focus on the toggle button across a live refresh', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      replaceContent(container, renderStatus(status(), running, noop));
      const toggle = $(container, '[data-action="toggle-pause"]');
      toggle.focus();
      expect(document.activeElement).toBe(toggle);

      replaceContent(container, renderStatus(status({ mode: 'paused' }), running, noop));
      const newToggle = $(container, '[data-action="toggle-pause"]');
      expect(document.activeElement).toBe(newToggle);
    } finally {
      document.body.removeChild(container);
    }
  });
});

describe('connectionLabel', () => {
  it('covers every state', () => {
    expect(connectionLabel(status({ connection: 'unconfigured' })).text).toBe('Not set up');
    expect(connectionLabel(status({ connection: 'connecting' })).text).toBe('Connecting…');
    expect(connectionLabel(status({ mode: 'idle_only', idle: false })).text).toBe(
      'Waiting for idle',
    );
    expect(connectionLabel(status({ mode: 'idle_only', idle: true })).text).toBe('Connected');
  });

  it('covers offline, paused and active connected states', () => {
    expect(connectionLabel(status({ connection: 'offline' })).text).toBe('Offline');
    expect(connectionLabel(status({ mode: 'paused' })).text).toBe('Paused');
    expect(connectionLabel(status()).text).toBe('Connected');
  });
});
