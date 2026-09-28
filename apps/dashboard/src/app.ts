import { parse, ProjectId, type NetworkSummary, type Project } from '@ai-commons/protocol';
import { CoordinatorRequestError, type CoordinatorClient } from './api.js';
import { h, replaceContent } from './dom.js';
import { formatRelativeTime } from './format.js';
import { renderMessage, renderOverview, renderProjectPage } from './views.js';

export type Route = { name: 'overview' } | { name: 'project'; id: string } | { name: 'not_found' };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '') || '/';
  if (path === '/') return { name: 'overview' };
  const match = /^\/projects\/([^/]+)$/.exec(path);
  if (match?.[1] !== undefined) {
    let id: string;
    try {
      id = decodeURIComponent(match[1]);
    } catch {
      return { name: 'not_found' };
    }
    return parse(ProjectId, id).ok ? { name: 'project', id } : { name: 'not_found' };
  }
  return { name: 'not_found' };
}

export interface DashboardOptions {
  root: HTMLElement;
  client: CoordinatorClient;
  pollMs?: number;
  maxBackoffMs?: number;
  now?: () => Date;
}

type ProjectEntry =
  | { state: 'loading' }
  | { state: 'ready'; project: Project }
  | { state: 'error'; error: CoordinatorRequestError };

const RERENDER_AFTER_MS = 30_000;

const isHidden = (): boolean => document.visibilityState === 'hidden';

export class Dashboard {
  private readonly client: CoordinatorClient;
  private readonly pollMs: number;
  private readonly maxBackoffMs: number;
  private readonly now: () => Date;

  private readonly statusEl: HTMLElement;
  private readonly bannerEl: HTMLElement;
  private readonly mainEl: HTMLElement;

  private network: NetworkSummary | undefined;
  private networkKey = '';
  private lastSuccess: Date | undefined;
  private error: CoordinatorRequestError | undefined;
  private failures = 0;
  private readonly projects = new Map<string, ProjectEntry>();
  private route: Route = { name: 'overview' };
  private renderedKey = '';
  private renderedAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private inFlight = false;

  constructor(options: DashboardOptions) {
    this.client = options.client;
    this.pollMs = options.pollMs ?? 5_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.now = options.now ?? (() => new Date());

    this.statusEl = h('p', { class: 'status', 'aria-live': 'off' });
    this.bannerEl = h('div', { class: 'banner-slot', role: 'alert' });
    this.mainEl = h('main', { id: 'main', class: 'container', tabindex: -1 });
    options.root.replaceChildren(
      h('a', { class: 'skip', href: '#main', 'data-skip': true }, 'Skip to content'),
      h(
        'header',
        { class: 'topbar' },
        h(
          'div',
          { class: 'container topbar-inner' },
          h(
            'a',
            { class: 'brand', href: '#/', 'data-key': 'brand' },
            h('span', { class: 'brand-mark', 'aria-hidden': 'true' }),
            'AI Commons',
          ),
          this.statusEl,
        ),
      ),
      h('div', { class: 'container' }, this.bannerEl),
      this.mainEl,
      h(
        'footer',
        { class: 'container footer' },
        'Open-source volunteer AI compute. Figures refresh every few seconds while this page is visible.',
      ),
    );
  }

  start(): void {
    window.addEventListener('hashchange', this.onHashChange);
    document.addEventListener('visibilitychange', this.onVisibility);
    document.addEventListener('click', this.onSkipLink);
    this.ticker = setInterval(() => this.renderStatus(), 1_000);
    this.onHashChange();
    void this.poll();
  }

  stop(): void {
    window.removeEventListener('hashchange', this.onHashChange);
    document.removeEventListener('visibilitychange', this.onVisibility);
    document.removeEventListener('click', this.onSkipLink);
    if (this.timer !== undefined) clearTimeout(this.timer);
    if (this.ticker !== undefined) clearInterval(this.ticker);
    this.timer = undefined;
  }

  /** Fetches the network summary once and re-renders. Exposed for tests. */
  async refresh(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const network = await this.client.network();
      this.network = network;
      this.networkKey = JSON.stringify({ ...network, generated_at: '' });
      this.lastSuccess = this.now();
      this.error = undefined;
      this.failures = 0;
    } catch (error) {
      this.error =
        error instanceof CoordinatorRequestError
          ? error
          : new CoordinatorRequestError('invalid', 'Unexpected error');
      this.failures += 1;
    } finally {
      this.inFlight = false;
    }
    this.render();
  }

  nextDelayMs(): number {
    if (this.failures === 0) return this.pollMs;
    return Math.min(this.maxBackoffMs, this.pollMs * 2 ** this.failures);
  }

  private readonly poll = async (): Promise<void> => {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (isHidden()) return;
    await this.refresh();
    if (!isHidden()) {
      this.timer = setTimeout(() => void this.poll(), this.nextDelayMs());
    }
  };

  private readonly onVisibility = (): void => {
    if (isHidden()) {
      if (this.timer !== undefined) clearTimeout(this.timer);
      this.timer = undefined;
    } else if (this.timer === undefined) {
      void this.poll();
    }
  };

  private readonly onHashChange = (): void => {
    this.route = parseRoute(window.location.hash);
    if (this.route.name === 'project') void this.loadProject(this.route.id);
    this.render(true);
    window.scrollTo?.(0, 0);
  };

  /** Hash routing owns `#…`, so the skip link focuses main manually. */
  private readonly onSkipLink = (event: MouseEvent): void => {
    const target = event.target;
    if (target instanceof Element && target.closest('[data-skip]')) {
      event.preventDefault();
      this.mainEl.focus();
    }
  };

  private async loadProject(id: string): Promise<void> {
    const existing = this.projects.get(id);
    if (existing?.state === 'loading') return;
    if (existing === undefined || existing.state === 'error') {
      this.projects.set(id, { state: 'loading' });
    }
    try {
      const project = await this.client.project(id);
      this.projects.set(id, { state: 'ready', project });
    } catch (error) {
      const err =
        error instanceof CoordinatorRequestError
          ? error
          : new CoordinatorRequestError('invalid', 'Unexpected error');
      // Keep a previously loaded definition if a refresh fails.
      if (this.projects.get(id)?.state !== 'ready')
        this.projects.set(id, { state: 'error', error: err });
    }
    this.render(true);
  }

  private render(force = false): void {
    this.renderStatus();
    this.renderBanner();

    const route = this.route;
    const project = route.name === 'project' ? this.projects.get(route.id) : undefined;
    const key = `${JSON.stringify(route)}|${project?.state ?? ''}|${this.networkKey}`;
    const now = this.now();
    if (!force && key === this.renderedKey && now.getTime() - this.renderedAt < RERENDER_AFTER_MS) {
      return;
    }
    this.renderedKey = key;
    this.renderedAt = now.getTime();

    const view = this.renderView(route, project, now);
    replaceContent(this.mainEl, view.node);
    document.title = view.title;
  }

  private renderView(
    route: Route,
    project: ProjectEntry | undefined,
    now: Date,
  ): { node: HTMLElement; title: string } {
    if (route.name === 'not_found') {
      return {
        node: renderMessage('Page not found', 'There is nothing at this address.', true),
        title: 'Not found · AI Commons',
      };
    }
    if (route.name === 'project') {
      if (project?.state === 'ready') {
        const summary = this.network?.projects.find((p) => p.id === route.id);
        return {
          node: renderProjectPage(project.project, summary, now),
          title: `${project.project.name} · AI Commons`,
        };
      }
      if (project?.state === 'error') {
        const missing = project.error.kind === 'http' && project.error.status === 404;
        return {
          node: renderMessage(
            missing ? 'Project not found' : 'Project unavailable',
            missing ? 'No project with this ID exists on this coordinator.' : project.error.message,
            true,
          ),
          title: 'Project · AI Commons',
        };
      }
      return { node: renderMessage('Loading project…', ''), title: 'Project · AI Commons' };
    }
    if (this.network === undefined) {
      return {
        node: renderMessage(
          this.error ? 'Coordinator unavailable' : 'Connecting…',
          this.error
            ? 'Network statistics will appear as soon as the coordinator responds.'
            : 'Fetching network statistics.',
        ),
        title: 'AI Commons',
      };
    }
    return { node: renderOverview(this.network, now), title: 'Network · AI Commons' };
  }

  private renderStatus(): void {
    const now = this.now();
    const live = this.error === undefined && this.lastSuccess !== undefined;
    const text = live
      ? `Live · updated ${formatRelativeTime((this.lastSuccess ?? now).toISOString(), now)}`
      : this.error
        ? this.lastSuccess
          ? `Offline · last update ${formatRelativeTime(this.lastSuccess.toISOString(), now)}`
          : 'Offline'
        : 'Connecting…';
    this.statusEl.className = `status ${live ? 'status-live' : this.error ? 'status-offline' : ''}`;
    if (this.statusEl.textContent !== text) this.statusEl.textContent = text;
  }

  private renderBanner(): void {
    const error = this.error;
    const current = this.bannerEl.getAttribute('data-message') ?? '';
    const message = error ? bannerText(error, Math.round(this.nextDelayMs() / 1000)) : '';
    if (message === current) return;
    this.bannerEl.setAttribute('data-message', message);
    this.bannerEl.replaceChildren(
      ...(message
        ? [h('div', { class: 'banner' }, h('strong', {}, 'Connection problem. '), message)]
        : []),
    );
  }
}

function bannerText(error: CoordinatorRequestError, retrySeconds: number): string {
  const retry = `Retrying in ${retrySeconds}s; figures shown may be out of date.`;
  switch (error.kind) {
    case 'offline':
      return `Cannot reach the coordinator. ${retry}`;
    case 'timeout':
      return `The coordinator is not responding. ${retry}`;
    case 'http':
      return `The coordinator returned an error (${error.message}). ${retry}`;
    case 'invalid':
      return `${error.message}. ${retry}`;
  }
}
