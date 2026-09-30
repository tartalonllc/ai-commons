import { describe, expect, it } from 'vitest';
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

  it('explains a $0 limit instead of drawing a meter', () => {
    const t = text(
      renderStatus(status({ limits: { daily_usd: 0, monthly_usd: 0 } }), running, noop),
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

  it('offers Resume when paused', () => {
    const el = renderStatus(status({ mode: 'paused' }), running, noop);
    expect(text(el)).toContain('Paused');
    expect($(el, '[data-action="toggle-pause"]').textContent).toBe('Resume contributions');
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
});
