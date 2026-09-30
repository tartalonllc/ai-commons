import type { WorkerConfig } from '@ai-commons/worker';
import { beforeEach, describe, expect, it } from 'vitest';
import { readSettingsForm, renderSettings, type SettingsHandlers } from '../src/settings-view.js';
import { $, config, flush, status } from './fixtures.js';

const KEY = 'sk-test-UIKEY1234567890abcdef';

function setValue(form: HTMLFormElement, name: string, value: string): void {
  $<HTMLInputElement>(form, `[name="${name}"]`).value = value;
}

function setChecked(form: HTMLFormElement, name: string, checked: boolean): void {
  $<HTMLInputElement>(form, `input[name="${name}"]`).checked = checked;
}

/** Explicitly clears the group so the test does not depend on radio-group support. */
function choose(form: HTMLFormElement, name: string, value: string): void {
  for (const el of form.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)) {
    el.checked = el.value === value;
  }
}

function mount(cfg: WorkerConfig = config(), overrides: Partial<SettingsHandlers> = {}) {
  const saved: WorkerConfig[] = [];
  const keys: [string, string][] = [];
  const confirms: string[] = [];
  const handlers: SettingsHandlers = {
    onSave: async (c) => {
      saved.push(c);
    },
    onProbe: async () => ({
      ok: true,
      models: [
        { name: 'qwen3:4b', context_window: 40_960 },
        { name: 'llama3.2:3b', context_window: 131_072 },
      ],
    }),
    onSetKey: async (provider, key) => {
      keys.push([provider, key]);
    },
    onDeleteKey: async () => undefined,
    confirm: async (message) => {
      confirms.push(message);
      return true;
    },
    disclosure: 'DISCLOSURE',
    ...overrides,
  };
  const form = renderSettings(cfg, status(), handlers);
  document.body.replaceChildren(form);
  return { form, saved, keys, confirms };
}

function submit(form: HTMLFormElement): void {
  form.dispatchEvent(new Event('submit', { cancelable: true }));
}

function enableOpenAI(form: HTMLFormElement): void {
  setChecked(form, 'openai.enabled', true);
  setValue(form, 'openai.model', 'gpt-4o-mini');
  setValue(form, 'openai.input_price', '0.15');
  setValue(form, 'openai.output_price', '0.6');
}

beforeEach(() => document.body.replaceChildren());

describe('readSettingsForm', () => {
  it('round-trips an unchanged form', () => {
    const cfg = config();
    const { form } = mount(cfg);
    expect(readSettingsForm(form, cfg)).toEqual({
      ok: true,
      config: { ...cfg, schedule: { mode: 'active', idle_after_minutes: 5 } },
    });
  });

  it('reads limits, schedule, and categories', () => {
    const { form } = mount();
    setValue(form, 'daily_usd', '0.25');
    setValue(form, 'monthly_usd', '5');
    choose(form, 'mode', 'idle_only');
    setValue(form, 'idle_after_minutes', '10');
    choose(form, 'categories_scope', 'selected');
    for (const el of form.querySelectorAll<HTMLInputElement>('input[name="category"]')) {
      el.checked = el.value === 'science' || el.value === 'climate';
    }
    const result = readSettingsForm(form, config());
    if (!result.ok) throw new Error(result.error);
    expect(result.config.limits.api).toEqual({ daily_usd: 0.25, monthly_usd: 5 });
    expect(result.config.schedule).toEqual({ mode: 'idle_only', idle_after_minutes: 10 });
    expect(result.config.projects.categories).toEqual(['science', 'climate']);
  });

  it('rejects a daily limit above the monthly limit', () => {
    const { form } = mount();
    setValue(form, 'daily_usd', '2');
    setValue(form, 'monthly_usd', '1');
    expect(readSettingsForm(form, config())).toMatchObject({ ok: false });
  });

  it('requires a model and prices for an enabled OpenAI provider', () => {
    const { form } = mount();
    setChecked(form, 'openai.enabled', true);
    expect(readSettingsForm(form, config())).toMatchObject({
      ok: false,
      error: expect.stringMatching(/model and its prices/),
    });
    enableOpenAI(form);
    choose(form, 'remote_scope', 'list');
    setValue(form, 'remote_projects', 'open-literature-demo, climate-notes');
    const result = readSettingsForm(form, config());
    if (!result.ok) throw new Error(result.error);
    expect(result.config.providers.find((p) => p.id === 'openai')).toEqual({
      id: 'openai',
      kind: 'remote',
      enabled: true,
      models: [{ name: 'gpt-4o-mini' }],
      pricing: { 'gpt-4o-mini': { input_per_mtok: 0.15, output_per_mtok: 0.6 } },
    });
    expect(result.config.projects.allow_remote_for_projects).toEqual([
      'open-literature-demo',
      'climate-notes',
    ]);
  });
});

describe('renderSettings', () => {
  it('adds detected models with their context windows', async () => {
    const { form } = mount();
    $(form, '[data-action="detect"]').click();
    await flush();
    await flush();
    const boxes = [...form.querySelectorAll<HTMLInputElement>('input[name="ollama.model"]')];
    expect(boxes.map((b) => [b.value, b.checked, b.dataset.contextWindow])).toEqual([
      ['qwen3:4b', true, '40960'],
      ['llama3.2:3b', false, '131072'],
    ]);
  });

  it('asks before enabling a remote provider and does not save if declined', async () => {
    const { form, saved, confirms } = mount(config(), { confirm: async () => false });
    enableOpenAI(form);
    submit(form);
    await flush();
    expect(saved).toHaveLength(0);
    expect(confirms).toHaveLength(0); // the override replaced the recorder
    expect($(form, '.save-bar .form-msg').textContent).toMatch(/Not saved/);
  });

  it('saves after the disclosure is accepted', async () => {
    const { form, saved, confirms } = mount();
    enableOpenAI(form);
    submit(form);
    await flush();
    expect(confirms).toEqual(['DISCLOSURE']);
    expect(saved).toHaveLength(1);
    expect($(form, '.save-bar .form-msg').textContent).toBe('Settings saved.');
  });

  it('sends the API key only through onSetKey and clears the field', async () => {
    const { form, keys, saved } = mount();
    const input = $<HTMLInputElement>(form, 'input[name="openai.key"]');
    input.value = KEY;
    $(form, '[data-action="save-key"]').click();
    expect(input.value).toBe('');
    await flush();
    expect(keys).toEqual([['openai', KEY]]);
    expect($(form, '[data-live="key-state"]').textContent).toBe('Key stored ✓');

    submit(form);
    await flush();
    expect(JSON.stringify(saved)).not.toContain(KEY);
  });
});
