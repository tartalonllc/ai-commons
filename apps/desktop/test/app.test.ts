import type { DaemonStatus, WorkerConfig } from '@ai-commons/worker';
import { describe, expect, it } from 'vitest';
import { DesktopApp } from '../src/app.js';
import type { Backend, SupervisorState } from '../src/ipc.js';
import { $, config, flush, status, text } from './fixtures.js';

function fakeBackend(supervisor: SupervisorState = { state: 'running' }) {
  let current = status();
  let push: ((s: DaemonStatus) => void) | undefined;
  let pushSupervisor: ((s: SupervisorState) => void) | undefined;
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
    onSupervisor: async (callback) => {
      pushSupervisor = callback;
      return () => undefined;
    },
  };
  return {
    backend,
    calls,
    saved,
    push: (s: DaemonStatus) => push?.(s),
    pushSupervisor: (s: SupervisorState) => pushSupervisor?.(s),
  };
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
    expect($(root, '[data-tab="settings"]').getAttribute('aria-current')).toBe('page');
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

  it('shows the supervisor banner and lets Restart work before the first status arrives', async () => {
    const fake = fakeBackend({
      state: 'stopped',
      message: 'Could not start the worker runtime: x',
    });
    fake.backend.getStatus = async () => {
      throw new Error('daemon not answering yet');
    };
    const { root, calls } = await start(fake);
    expect(text(root)).toContain('Worker stopped: Could not start the worker runtime: x');
    $(root, '[data-action="restart"]').click();
    await flush();
    expect(calls).toContain('restart');
  });

  it('ignores a stale supervisorState() snapshot once a real supervisor event has arrived', async () => {
    const fake = fakeBackend();
    fake.backend.supervisorState = async () => {
      // A real event races ahead of this in-flight snapshot request.
      fake.pushSupervisor({ state: 'restarting', message: 'racing the snapshot' });
      return { state: 'running' };
    };
    const { root } = await start(fake);
    expect(text(root)).toContain('racing the snapshot');
  });

  it('shows a banner when getConfig fails', async () => {
    const fake = fakeBackend();
    fake.backend.getConfig = async () => {
      throw new Error('config unavailable');
    };
    const { root } = await start(fake);
    $(root, '[data-tab="settings"]').click();
    await flush();
    expect($(root, '[role="alert"]').textContent).toBe('config unavailable');
  });

  it('shows a notice when pausing fails', async () => {
    const fake = fakeBackend();
    fake.backend.setMode = async () => {
      throw new Error('daemon busy');
    };
    const { root } = await start(fake);
    $(root, '[data-action="toggle-pause"]').click();
    await flush();
    expect(text(root)).toContain('daemon busy');
  });

  it('ignores a second click while a pause/resume request is in flight', async () => {
    const fake = fakeBackend();
    let resolveSetMode: (() => void) | undefined;
    let setModeCalls = 0;
    fake.backend.setMode = async () => {
      setModeCalls++;
      await new Promise<void>((resolve) => {
        resolveSetMode = resolve;
      });
    };
    const { root } = await start(fake);
    $(root, '[data-action="toggle-pause"]').click();
    $(root, '[data-action="toggle-pause"]').click();
    await flush();
    expect(setModeCalls).toBe(1);
    resolveSetMode?.();
    await flush();
  });

  it('clears a stale notice once a fresh status arrives', async () => {
    // Scoped to <main>: the persistent live region legitimately keeps its
    // last announcement around, but the on-screen notice banner must clear.
    const fake = fakeBackend();
    fake.backend.setMode = async () => {
      throw new Error('daemon busy');
    };
    const { root, push } = await start(fake);
    $(root, '[data-action="toggle-pause"]').click();
    await flush();
    expect(text($(root, 'main'))).toContain('daemon busy');
    push(status());
    expect(text($(root, 'main'))).not.toContain('daemon busy');
  });

  it('only renders the latest settings response after switching tabs and back', async () => {
    const fake = fakeBackend();
    const resolvers: ((c: WorkerConfig) => void)[] = [];
    fake.backend.getConfig = () =>
      new Promise((resolve) => {
        resolvers.push(resolve);
      });
    const { root } = await start(fake);

    $(root, '[data-tab="settings"]').click(); // request #1, left pending
    await flush();
    $(root, '[data-tab="status"]').click();
    await flush();
    $(root, '[data-tab="settings"]').click(); // request #2
    await flush();

    // Resolve out of order: the newer request settles first.
    resolvers[1]?.(config({ coordinator_url: 'https://second.example.org' }));
    await flush();
    resolvers[0]?.(config({ coordinator_url: 'https://first.example.org' }));
    await flush();

    expect($<HTMLInputElement>(root, 'input[name="coordinator_url"]').value).toBe(
      'https://second.example.org',
    );
  });

  describe('tabs', () => {
    it('marks the selected view with aria-current, not aria-selected', async () => {
      const { root } = await start();
      expect($(root, '[data-tab="status"]').getAttribute('aria-current')).toBe('page');
      expect($(root, '[data-tab="status"]').getAttribute('aria-selected')).toBeNull();
      expect($(root, '[data-tab="settings"]').getAttribute('aria-current')).toBeNull();
      $(root, '[data-tab="settings"]').click();
      await flush();
      expect($(root, '[data-tab="settings"]').getAttribute('aria-current')).toBe('page');
      expect($(root, '[data-tab="status"]').getAttribute('aria-current')).toBeNull();
    });
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

      push(status({ connection: 'offline' }));
      expect(live.textContent).toBe('Connection: Offline');

      push(status({ connection: 'offline' }));
      expect(live.textContent).toBe('Connection: Offline');

      push(status({ connection: 'connected' }));
      expect(live.textContent).toBe('Connection: Connected');
    });

    it('announces restarting then stopped supervisor events, and renders their banners', async () => {
      const { root, pushSupervisor } = await start();
      const live = $(root, '[data-live-region]');

      pushSupervisor({ state: 'restarting', message: 'retry 1/5' });
      expect(text(root)).toContain('retry 1/5');
      expect(live.textContent).toBe('retry 1/5');

      pushSupervisor({ state: 'stopped', message: 'exit 1' });
      expect(text(root)).toContain('Worker stopped: exit 1');
      expect(live.textContent).toBe('Worker stopped: exit 1');
    });

    it('announces recovery once the worker is running again after stopping', async () => {
      const { pushSupervisor, root } = await start();
      const live = $(root, '[data-live-region]');
      pushSupervisor({ state: 'stopped', message: 'exit 1' });
      pushSupervisor({ state: 'running' });
      expect(live.textContent).toBe('Worker running again.');
    });

    it('does not announce recovery on the very first running event', async () => {
      const { root } = await start();
      const live = $(root, '[data-live-region]');
      expect(live.textContent).not.toBe('Worker running again.');
    });
  });
});
