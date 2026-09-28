import { describe, expect, it } from 'vitest';
import { h } from '../src/dom.js';
import { renderOverview, renderProjectPage, workerStatus } from '../src/views.js';
import { network, NOW, project } from './fixtures.js';

const XSS = '<img src=x onerror=alert(1)>';

function text(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ');
}

describe('renderOverview', () => {
  it('shows network, compute, projects, and workers', () => {
    const el = renderOverview(network(), NOW);
    const t = text(el);
    expect(t).toContain('Connected workers2');
    expect(t).toContain('Tasks completed8,214');
    expect(t).toContain('Tokens processed14.8M');
    expect(t).toContain('63.0 h');
    expect(t).toContain('$7.84');
    expect(t).toContain('7,840 AI Compute Units');
    expect(t).toContain('731 / 1,000');
    expect(t).toContain('73.1%');

    const link = el.querySelector('a[href="#/projects/open-literature-demo"]');
    expect(link?.textContent).toBe('Open Literature Classification');

    const bar = el.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuenow')).toBe('73.1');
    expect((bar?.firstElementChild as HTMLElement | null)?.style.width).toBe('73.1%');
  });

  it('marks stale workers offline and shows relative times', () => {
    const el = renderOverview(network(), NOW);
    const rows = el.querySelectorAll('tbody tr');
    const workerRows = Array.from(rows).filter((r) => r.querySelector('code'));
    expect(text(workerRows[0] as Element)).toContain('Available');
    expect(text(workerRows[0] as Element)).toContain('30s ago');
    expect(text(workerRows[1] as Element)).toContain('Offline');
    expect(text(workerRows[1] as Element)).toContain('1 h ago');
  });

  it('never exposes provider or machine details', () => {
    const t = text(renderOverview(network(), NOW)).toLowerCase();
    for (const word of ['ollama', 'openai', 'windows', 'ip address']) expect(t).not.toContain(word);
  });

  it('renders empty states', () => {
    const el = renderOverview(network({ projects: [], workers: [] }), NOW);
    expect(text(el)).toContain('No projects have been published yet.');
    expect(text(el)).toContain('No workers have connected yet.');
    expect(el.querySelector('table')).toBeNull();
  });

  it('renders untrusted project names as text, not HTML', () => {
    const base = network();
    const summary = base.projects[0];
    if (!summary) throw new Error('fixture');
    const el = renderOverview({ ...base, projects: [{ ...summary, name: XSS }] }, NOW);
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('a[href^="#/projects/"]')?.textContent).toBe(XSS);
  });
});

describe('renderProjectPage', () => {
  const summary = network().projects[0];

  it('shows §38 progress, contributors, and compute donated', () => {
    const t = text(renderProjectPage(project(), summary, NOW));
    expect(t).toContain('Open Literature Classification');
    expect(t).toContain('Classify 1,000 scientific abstracts');
    expect(t).toContain('73.1%');
    expect(t).toContain('731 / 1,000 tasks');
    expect(t).toContain('Contributors2');
    expect(t).toContain('Tokens processed318.5K');
    expect(t).toContain('Local inference2.5 h');
    expect(t).toContain('API compute donated$0.14');
  });

  it('shows the prompt template and schemas read-only (§44)', () => {
    const el = renderProjectPage(project(), summary, NOW);
    const blocks = Array.from(el.querySelectorAll('figure.code'));
    const byCaption = new Map(
      blocks.map((f) => [f.querySelector('figcaption')?.textContent, f.querySelector('pre')]),
    );
    expect(byCaption.get('System prompt')?.textContent).toBe('Classify. JSON only.');
    expect(byCaption.get('User prompt template')?.textContent).toBe(
      'Title: {{title}}\n\n{{abstract}}',
    );
    expect(JSON.parse(byCaption.get('Output schema')?.textContent ?? '')).toEqual(
      project().output_schema,
    );
    expect(el.querySelector('textarea, input, [contenteditable]')).toBeNull();
    expect(text(el)).toContain('Consensus, 2 independent results on field');
  });

  it('explains local-only projects', () => {
    const p = project({
      requirements: { ...project().requirements, local_models_only: true },
    });
    expect(text(renderProjectPage(p, summary, NOW))).toContain('never leaves volunteer machines');
  });

  it('degrades gracefully without a network summary', () => {
    const t = text(renderProjectPage(project(), undefined, NOW));
    expect(t).toContain('Progress unavailable');
  });

  it('renders hostile project text inertly', () => {
    const el = renderProjectPage(
      project({
        name: XSS,
        description: `<script>alert(1)</script>${XSS}`,
        prompt: { system: XSS, user: '{{title}}' },
      }),
      summary,
      NOW,
    );
    expect(el.querySelector('img, script')).toBeNull();
    expect(el.querySelector('h1')?.textContent).toBe(XSS);
    expect(el.querySelector('.goal')?.textContent).toBe(`<script>alert(1)</script>${XSS}`);
  });
});

describe('h', () => {
  it('refuses event handler and style attributes', () => {
    expect(() => h('div', { onclick: 'alert(1)' })).toThrow();
    expect(() => h('div', { OnMouseOver: 'x' })).toThrow();
    expect(() => h('div', { style: 'color:red' })).toThrow();
  });
});

it('workerStatus keeps reported status for recently seen workers', () => {
  const w = network().workers[0];
  if (!w) throw new Error('fixture');
  expect(workerStatus(w, NOW)).toBe('available');
});
