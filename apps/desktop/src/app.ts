import type { DaemonStatus } from '@ai-commons/worker';
import { h, replaceContent } from './dom.js';
import { errorText } from './format.js';
import type { Backend, SupervisorState } from './ipc.js';
import { renderSettings } from './settings-view.js';
import { connectionLabel, renderStatus } from './status-view.js';

export interface AppOptions {
  backend: Backend;
  confirm: (message: string) => Promise<boolean>;
  disclosure: string;
}

type Tab = 'status' | 'settings';

export class DesktopApp {
  private status: DaemonStatus | undefined;
  private supervisor: SupervisorState = { state: 'running' };
  private tab: Tab = 'status';
  private notice: string | undefined;
  private readonly main: HTMLElement;
  private readonly tabs: Record<Tab, HTMLButtonElement>;
  private readonly liveRegion: HTMLElement;
  // Tracks what the live region last announced for each source, independent of
  // whatever text is on screen, so a repeat of the same state is silent.
  private lastLiveConnection: string | undefined;
  private lastLiveSupervisor: string | undefined;

  constructor(
    root: HTMLElement,
    private readonly opts: AppOptions,
  ) {
    this.tabs = {
      status: this.tabButton('status', 'Status'),
      settings: this.tabButton('settings', 'Settings'),
    };
    this.main = h('main', { id: 'view' });
    this.liveRegion = h('div', {
      class: 'sr-only',
      'aria-live': 'polite',
      'data-live-region': true,
    });
    root.replaceChildren(
      h(
        'header',
        { class: 'app-header' },
        h('h1', {}, 'AI Commons'),
        h('nav', { role: 'tablist' }, this.tabs.status, this.tabs.settings),
      ),
      this.main,
      this.liveRegion,
    );
  }

  async start(): Promise<void> {
    const { backend } = this.opts;
    await backend.onStatus((s) => this.onStatus(s));
    await backend.onSupervisor((s) => {
      this.supervisor = s;
      this.announceSupervisor();
      if (this.tab === 'status') this.renderStatusTab();
    });
    try {
      this.supervisor = await backend.supervisorState();
      this.announceSupervisor();
    } catch {
      // Keep the default; the next supervisor event corrects it.
    }
    try {
      this.onStatus(await backend.getStatus());
    } catch (error) {
      this.notice = errorText(error);
      this.renderStatusTab();
    }
  }

  select(tab: Tab): void {
    this.tab = tab;
    for (const [name, button] of Object.entries(this.tabs)) {
      button.setAttribute('aria-selected', String(name === tab));
    }
    if (tab === 'status') this.renderStatusTab();
    else void this.showSettings();
  }

  private onStatus(s: DaemonStatus): void {
    this.status = s;
    this.announceConnection(s);
    if (this.tab === 'status') {
      this.renderStatusTab();
      return;
    }
    // Never re-render the settings form under the user's edits.
    for (const el of this.main.querySelectorAll('[data-live="connection"]')) {
      el.textContent = connectionLabel(s).text;
    }
  }

  /**
   * The status view is rebuilt on every status push, so its `role="status"`
   * banners are new DOM nodes that screen readers often fail to announce.
   * This persistent live region announces the same changes reliably, and
   * only when the announced text actually changes.
   */
  private announceConnection(s: DaemonStatus): void {
    const text = connectionLabel(s).text;
    if (text === this.lastLiveConnection) return;
    this.lastLiveConnection = text;
    this.liveRegion.textContent = `Connection: ${text}`;
  }

  private announceSupervisor(): void {
    const key = `${this.supervisor.state}:${this.supervisor.message ?? ''}`;
    if (key === this.lastLiveSupervisor) return;
    this.lastLiveSupervisor = key;
    if (this.supervisor.state === 'stopped') {
      this.liveRegion.textContent = `Worker stopped: ${this.supervisor.message ?? 'unknown error'}`;
    } else if (this.supervisor.state === 'restarting') {
      this.liveRegion.textContent = this.supervisor.message ?? 'Restarting the worker…';
    }
  }

  private renderStatusTab(): void {
    if (!this.status) {
      replaceContent(this.main, h('p', { class: 'muted' }, this.notice ?? 'Starting the worker…'));
      return;
    }
    replaceContent(
      this.main,
      renderStatus(
        this.status,
        this.supervisor,
        { onTogglePause: () => void this.togglePause(), onRestart: () => void this.restart() },
        this.notice,
      ),
    );
  }

  private async togglePause(): Promise<void> {
    if (!this.status) return;
    const { backend } = this.opts;
    try {
      if (this.status.mode === 'paused') await backend.resume();
      else await backend.setMode('paused');
      this.notice = undefined;
      this.onStatus(await backend.getStatus());
    } catch (error) {
      this.notice = errorText(error);
      this.renderStatusTab();
    }
  }

  private async restart(): Promise<void> {
    try {
      await this.opts.backend.restartWorker();
      this.notice = undefined;
    } catch (error) {
      this.notice = errorText(error);
    }
    this.renderStatusTab();
  }

  private async showSettings(): Promise<void> {
    const { backend, confirm, disclosure } = this.opts;
    replaceContent(this.main, h('p', { class: 'muted' }, 'Loading settings…'));
    try {
      const config = await backend.getConfig();
      if (this.tab !== 'settings') return;
      replaceContent(
        this.main,
        renderSettings(config, this.status, {
          onSave: async (next) => {
            await backend.saveConfig(next);
          },
          onProbe: (id, endpoint) => backend.probeProvider(id, endpoint),
          onSetKey: (provider, key) => backend.setKey(provider, key),
          onDeleteKey: (provider) => backend.deleteKey(provider),
          confirm,
          // Read live, at save time: an untouched mode radio must reflect the
          // daemon's current mode (e.g. a tray Pause/Resume), not the mode the
          // settings form happened to render with.
          currentMode: () => this.status?.mode,
          disclosure,
        }),
      );
    } catch (error) {
      replaceContent(
        this.main,
        h('p', { class: 'banner danger', role: 'alert' }, errorText(error)),
      );
    }
  }

  private tabButton(tab: Tab, label: string): HTMLButtonElement {
    const button = h(
      'button',
      {
        type: 'button',
        role: 'tab',
        'data-tab': tab,
        'aria-selected': tab === 'status' ? 'true' : 'false',
      },
      label,
    );
    button.addEventListener('click', () => this.select(tab));
    return button;
  }
}
