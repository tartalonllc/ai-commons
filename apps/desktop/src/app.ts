import type { DaemonStatus } from '@ai-commons/worker';
import { h, replaceContent } from './dom.js';
import { errorText } from './format.js';
import type { Backend, SupervisorState } from './ipc.js';
import { renderSettings } from './settings-view.js';
import { connectionLabel, renderStarting, renderStatus } from './status-view.js';

export interface AppOptions {
  backend: Backend;
  confirm: (message: string) => Promise<boolean>;
  disclosure: string;
}

type Tab = 'status' | 'settings';

/** Call `start()` exactly once: it registers backend listeners that are never removed. */
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
  private lastLiveSupervisorKey: string | undefined;
  private lastLiveSupervisorState: SupervisorState['state'] | undefined;
  // True once a real supervisor event has arrived, so the startup snapshot
  // fetched from supervisorState() never overwrites it with stale data.
  private supervisorEventReceived = false;
  private togglePauseInFlight = false;
  // Guards showSettings() against an older getConfig() response resolving
  // after a newer one (e.g. Settings -> Status -> Settings in quick succession).
  private settingsRequestId = 0;

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
        h('nav', { 'aria-label': 'Views' }, this.tabs.status, this.tabs.settings),
      ),
      this.main,
      this.liveRegion,
    );
    // Show something before any backend call resolves.
    this.renderStatusTab();
  }

  async start(): Promise<void> {
    const { backend } = this.opts;
    await backend.onStatus((s) => this.onStatus(s));
    await backend.onSupervisor((s) => {
      this.supervisorEventReceived = true;
      this.supervisor = s;
      this.announceSupervisor();
      this.renderStatusTab();
    });
    try {
      const snapshot = await backend.supervisorState();
      // A real event may have arrived while this request was in flight; never
      // let a stale snapshot win over it.
      if (!this.supervisorEventReceived) {
        this.supervisor = snapshot;
        this.announceSupervisor();
        this.renderStatusTab();
      }
    } catch {
      // Keep the default; the next supervisor event corrects it.
    }
    try {
      this.onStatus(await backend.getStatus());
    } catch (error) {
      this.setNotice(errorText(error));
      this.renderStatusTab();
    }
  }

  select(tab: Tab): void {
    if (tab === this.tab) return;
    this.tab = tab;
    for (const [name, button] of Object.entries(this.tabs)) {
      if (name === tab) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    if (tab === 'status') this.renderStatusTab();
    else void this.showSettings();
  }

  private onStatus(s: DaemonStatus): void {
    this.status = s;
    // A fresh status supersedes any startup or action notice.
    this.notice = undefined;
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

  private setNotice(text: string | undefined): void {
    this.notice = text;
    if (text) this.announce(text);
  }

  private announce(text: string): void {
    this.liveRegion.textContent = text;
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
    this.announce(`Connection: ${text}`);
  }

  private announceSupervisor(): void {
    const { state, message } = this.supervisor;
    const key = `${state}:${message ?? ''}`;
    if (key === this.lastLiveSupervisorKey) return;
    const previousState = this.lastLiveSupervisorState;
    this.lastLiveSupervisorKey = key;
    this.lastLiveSupervisorState = state;
    if (state === 'stopped') {
      this.announce(`Worker stopped: ${message ?? 'unknown error'}`);
    } else if (state === 'restarting') {
      this.announce(message ?? 'Restarting the worker…');
    } else if (
      state === 'running' &&
      (previousState === 'stopped' || previousState === 'restarting')
    ) {
      this.announce('Worker running again.');
    }
  }

  private renderStatusTab(): void {
    if (this.tab !== 'status') return;
    if (!this.status) {
      replaceContent(this.main, renderStarting(this.supervisor, this.statusActions(), this.notice));
      return;
    }
    replaceContent(
      this.main,
      renderStatus(this.status, this.supervisor, this.statusActions(), this.notice),
    );
  }

  private statusActions() {
    return { onTogglePause: () => void this.togglePause(), onRestart: () => void this.restart() };
  }

  private async togglePause(): Promise<void> {
    if (!this.status || this.togglePauseInFlight) return;
    this.togglePauseInFlight = true;
    const { backend } = this.opts;
    try {
      if (this.status.mode === 'paused') await backend.resume();
      else await backend.setMode('paused');
      this.setNotice(undefined);
      this.onStatus(await backend.getStatus());
    } catch (error) {
      this.setNotice(errorText(error));
      this.renderStatusTab();
    } finally {
      this.togglePauseInFlight = false;
    }
  }

  private async restart(): Promise<void> {
    try {
      await this.opts.backend.restartWorker();
      this.setNotice(undefined);
    } catch (error) {
      this.setNotice(errorText(error));
    }
    this.renderStatusTab();
  }

  private async showSettings(): Promise<void> {
    const { backend, confirm, disclosure } = this.opts;
    const requestId = ++this.settingsRequestId;
    const stale = () => this.tab !== 'settings' || requestId !== this.settingsRequestId;
    replaceContent(this.main, h('p', { class: 'muted' }, 'Loading settings…'));
    try {
      const config = await backend.getConfig();
      if (stale()) return;
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
      if (stale()) return;
      replaceContent(
        this.main,
        h('p', { class: 'banner danger', role: 'alert' }, errorText(error)),
      );
    }
  }

  private tabButton(tab: Tab, label: string): HTMLButtonElement {
    const button = h('button', { type: 'button', 'data-tab': tab }, label);
    if (tab === this.tab) button.setAttribute('aria-current', 'page');
    button.addEventListener('click', () => this.select(tab));
    return button;
  }
}
