import type { DaemonStatus, WorkerConfig } from '@ai-commons/worker';
import { describe, expect, it } from 'vitest';
import { DesktopApp } from '../src/app.js';
import type { Backend, SupervisorState } from '../src/ipc.js';
import { $, config, flush, status, text } from './fixtures.js';

function fakeBackend(supervisor: SupervisorState = { state: 'running' }) {
  let current = status();
  let push: ((s: DaemonStatus) => void) | undefined;
  const calls: string[] = [];
  const saved: WorkerConfig[] = [];
  const backend: Backend = {
    getStatus: async () => current,
    getConfig: async () => config(),
    saveConfig: async (c) => {
      calls.push('saveConfig');
      saved.push(c);
      return c;
    },
    setMode: async (mode) => {
      calls.push(`setMode:${mode}`);
      current = { ...current, mode };
    },
    resume: async () => {
      calls.push('resume');
      current = { ...current, mode: 'active' };
    },
    setKey: async () => {
      calls.push('setKey');
    },
    deleteKey: async () => {
      calls.push('deleteKey');
    },
    probeProvider: async () => ({ ok: true, models: [] }),
    restartWorker: async () => {
      calls.push('restart');
    },
    supervisorState: async () => supervisor,
    onStatus: async (callback) => {
      push = callback;
      return () => undefined;
    },
    onSupervisor: async () => () => undefined,
  };
  return { backend, calls, saved, push: (s: DaemonStatus) => push?.(s) };
}

async function start(fake = fakeBackend()) {
  const root = document.createElement('div');
  const app = new DesktopApp(root, {
    backend: fake.backend,
    confirm: async () => true,
    disclosure: 'D',
  });
  await app.start();
  return { root, app, ...fake };
}

describe('DesktopApp', () => {
  it('renders status and applies live updates', async () => {
    const { root, push } = await start();
    expect(text(root)).toContain('Open Literature Demo');
    push(status({ today: { ...status().today, tasks_submitted: 239 } }));
    expect(text(root)).toContain('Tasks239');
  });

  it('pauses, then resumes to the remembered mode', async () => {
    const { root, calls } = await start();
    $(root, '[data-action="toggle-pause"]').click();
    await flush();
    expect(calls).toContain('setMode:paused');
    expect($(root, '[data-action="toggle-pause"]').textContent).toBe('Resume contributions');
    $(root, '[data-action="toggle-pause"]').click();
    await flush();
    expect(calls).toContain('resume');
  });

  it('keeps settings edits when status events arrive', async () => {
    const { root, push } = await start();
    $(root, '[data-tab="settings"]').click();
    await flush();
    const url = $<HTMLInputElement>(root, 'input[name="coordinator_url"]');
    url.value = 'https://edited.example.org';
    push(status({ connection: 'offline' }));
    expect($<HTMLInputElement>(root, 'input[name="coordinator_url"]').value).toBe(
      'https://edited.example.org',
    );
    expect($(root, '[data-live="connection"]').textContent).toBe('Offline');
    expect($(root, '[data-tab="settings"]').getAttribute('aria-selected')).toBe('true');
  });

  it('shows why the worker stopped and restarts it', async () => {
    const { root, calls } = await start(fakeBackend({ state: 'stopped', message: 'exit code 1' }));
    expect(text(root)).toContain('Worker stopped: exit code 1');
    $(root, '[data-action="restart"]').click();
    await flush();
    expect(calls).toContain('restart');
  });

  it("saves the daemon's live mode, not the settings form's stale snapshot", async () => {
    // The tray can pause/resume the worker while Settings is open; readSettingsForm
    // trusts handlers.currentMode() over an untouched mode radio (see settings-view.ts).
    const { root, push, saved } = await start();
    $(root, '[data-tab="settings"]').click();
    await flush();
    push(status({ mode: 'paused' }));
    const idleAfter = $<HTMLInputElement>(root, 'input[name="idle_after_minutes"]');
    idleAfter.value = '15';
    $(root, 'form').dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(saved).toHaveLength(1);
    expect(saved[0]?.schedule.mode).toBe('paused');
  });

  describe('live region', () => {
    it('has a persistent, visually hidden live region next to <main>', async () => {
      const { root } = await start();
      const live = $(root, '[data-live-region]');
      expect(live.getAttribute('aria-live')).toBe('polite');
      expect(live.className).toContain('sr-only');
    });

    it('announces a connection change and ignores a repeat of the same state', async () => {
      const { root, push } = await start();
      const live = $(root, '[data-live-region]');

      // Rebuilding <main> on every status push means role="status" banners
      // inside it are new nodes that screen readers often miss; this region
      // persists across renders instead. Shadow textContent on the live
      // instance to count writes without depending on a MutationObserver.
      let value = live.textContent;
      let sets = 0;
      Object.defineProperty(live, 'textContent', {
        configurable: true,
        get: () => value,
        set: (v: string) => {
          sets++;
          value = v;
        },
      });

      push(status({ connection: 'offline' }));
      expect(live.textContent).toBe('Connection: Offline');
      expect(sets).toBe(1);

      push(status({ connection: 'offline' }));
      expect(live.textContent).toBe('Connection: Offline');
      expect(sets).toBe(1);
    });
  });
});
