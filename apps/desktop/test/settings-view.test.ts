import type { ScheduleMode, WorkerConfig } from '@ai-commons/worker';
import { beforeEach, describe, expect, it } from 'vitest';
import { readSettingsForm, renderSettings, type SettingsHandlers } from '../src/settings-view.js';
import { $, config, flush, status, text } from './fixtures.js';

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
  const deletedKeys: string[] = [];
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
    onDeleteKey: async (provider) => {
      deletedKeys.push(provider);
    },
    confirm: async () => true,
    currentMode: () => undefined,
    disclosure: 'DISCLOSURE',
    ...overrides,
  };
  const form = renderSettings(cfg, status(), handlers);
  document.body.replaceChildren(form);
  return { form, saved, keys, deletedKeys };
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
      // worker_id is never carried; the daemon restores it (see the dedicated test below).
      config: { ...cfg, worker_id: undefined, schedule: { mode: 'active', idle_after_minutes: 5 } },
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

  it('never carries worker_id, whether or not the coordinator URL changed', () => {
    const cfg = config(); // has worker_id: 'worker_abc123'
    const { form } = mount(cfg);

    const same = readSettingsForm(form, cfg);
    if (!same.ok) throw new Error(same.error);
    expect(same.config).not.toHaveProperty('worker_id');

    setValue(form, 'coordinator_url', 'http://localhost:9999');
    const changed = readSettingsForm(form, cfg);
    if (!changed.ok) throw new Error(changed.error);
    expect(changed.config).not.toHaveProperty('worker_id');
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

  it('rejects a zero price for a paid model', () => {
    const { form } = mount();
    enableOpenAI(form);
    setValue(form, 'openai.input_price', '0');
    expect(readSettingsForm(form, config())).toMatchObject({
      ok: false,
      error: expect.stringMatching(/greater than zero/),
    });
  });

  it('rejects an invalid project ID in the allow-list', () => {
    const { form } = mount();
    choose(form, 'remote_scope', 'list');
    setValue(form, 'remote_projects', 'Not_Valid!');
    expect(readSettingsForm(form, config())).toMatchObject({
      ok: false,
      error: expect.stringContaining('Not_Valid!'),
    });
  });

  it('preserves another provider and the rest of the OpenAI provider on partial edits', () => {
    const cfg = config({
      providers: [
        ...config().providers,
        {
          id: 'openai',
          kind: 'remote',
          enabled: true,
          models: [{ name: 'gpt-4o-mini' }, { name: 'gpt-4o' }],
          pricing: {
            'gpt-4o-mini': { input_per_mtok: 0.15, output_per_mtok: 0.6 },
            'gpt-4o': { input_per_mtok: 5, output_per_mtok: 15 },
          },
        },
        { id: 'anthropic', kind: 'remote', enabled: false, models: [] },
      ],
    });
    const { form } = mount(cfg);
    setValue(form, 'openai.input_price', '0.2');

    const result = readSettingsForm(form, cfg);
    if (!result.ok) throw new Error(result.error);

    expect(result.config.providers.find((p) => p.id === 'openai')).toEqual({
      id: 'openai',
      kind: 'remote',
      enabled: true,
      models: [{ name: 'gpt-4o-mini' }, { name: 'gpt-4o' }],
      pricing: {
        'gpt-4o-mini': { input_per_mtok: 0.2, output_per_mtok: 0.6 },
        'gpt-4o': { input_per_mtok: 5, output_per_mtok: 15 },
      },
    });
    expect(result.config.providers.find((p) => p.id === 'anthropic')).toEqual({
      id: 'anthropic',
      kind: 'remote',
      enabled: false,
      models: [],
    });
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

  it('deduplicates probe results and keeps a retained model context window', async () => {
    const ollamaBase = config().providers.find((p) => p.id === 'ollama');
    if (!ollamaBase) throw new Error('fixture missing ollama provider');
    const cfg = config({
      providers: [
        {
          ...ollamaBase,
          models: [
            { name: 'qwen3:4b', context_window: 40_960 },
            { name: 'custom:1b', context_window: 8_192 },
          ],
        },
      ],
    });
    const { form } = mount(cfg, {
      onProbe: async () => ({
        ok: true,
        models: [
          { name: 'qwen3:4b', context_window: 40_960 },
          { name: 'qwen3:4b', context_window: 40_960 }, // a flaky API repeating itself
        ],
      }),
    });
    $(form, '[data-action="detect"]').click();
    await flush();
    await flush();
    const boxes = [...form.querySelectorAll<HTMLInputElement>('input[name="ollama.model"]')];
    expect(boxes.map((b) => [b.value, b.dataset.contextWindow])).toEqual([
      ['qwen3:4b', '40960'],
      ['custom:1b', '8192'],
    ]);
  });

  it('shows a probe failure message', async () => {
    const { form } = mount(config(), {
      onProbe: async () => ({ ok: false, message: 'Ollama is not reachable.', models: [] }),
    });
    $(form, '[data-action="detect"]').click();
    await flush();
    await flush();
    expect($(form, '[data-msg="probe"]').textContent).toBe('Ollama is not reachable.');
  });

  it('never turns a malicious model name into an element', async () => {
    const payload = '<img src=x onerror=alert(1)>';
    const { form } = mount(config(), {
      onProbe: async () => ({ ok: true, models: [{ name: payload }] }),
    });
    $(form, '[data-action="detect"]').click();
    await flush();
    await flush();
    expect(form.querySelector('img')).toBeNull();
    expect(text(form)).toContain(payload);
  });

  it('asks before enabling a remote provider and does not save if declined', async () => {
    let confirmCalls = 0;
    const { form, saved } = mount(config(), {
      confirm: async () => {
        confirmCalls++;
        return false;
      },
    });
    enableOpenAI(form);
    submit(form);
    await flush();
    expect(confirmCalls).toBe(1);
    expect(saved).toHaveLength(0);
    expect($(form, '[data-msg="form"]').textContent).toMatch(/Not saved/);
  });

  it('saves after the disclosure is accepted', async () => {
    let confirmCalls = 0;
    const { form, saved } = mount(config(), {
      confirm: async (message) => {
        expect(message).toBe('DISCLOSURE');
        confirmCalls++;
        return true;
      },
    });
    enableOpenAI(form);
    submit(form);
    await flush();
    expect(confirmCalls).toBe(1);
    expect(saved).toHaveLength(1);
    expect($(form, '[data-msg="form"]').textContent).toBe('Settings saved.');
  });

  it('does not prompt again when OpenAI was already enabled', async () => {
    const cfg = config({
      providers: [
        ...config().providers,
        {
          id: 'openai',
          kind: 'remote',
          enabled: true,
          models: [{ name: 'gpt-4o-mini' }],
          pricing: { 'gpt-4o-mini': { input_per_mtok: 0.15, output_per_mtok: 0.6 } },
        },
      ],
    });
    let confirmCalls = 0;
    const { form, saved } = mount(cfg, {
      confirm: async () => {
        confirmCalls++;
        return true;
      },
    });
    submit(form);
    await flush();
    expect(confirmCalls).toBe(0);
    expect(saved).toHaveLength(1);
  });

  it('shows an error and re-enables the button when onSave rejects', async () => {
    const { form } = mount(config(), {
      onSave: async () => {
        throw new Error('boom');
      },
    });
    submit(form);
    await flush();
    expect($(form, '[data-msg="form"]').textContent).toBe('boom');
    expect($<HTMLButtonElement>(form, 'button[type="submit"]').disabled).toBe(false);
  });

  it('shows an error and re-enables the button when confirm rejects', async () => {
    const { form, saved } = mount(config(), {
      confirm: async () => {
        throw new Error('dialog closed');
      },
    });
    enableOpenAI(form);
    submit(form);
    await flush();
    expect(saved).toHaveLength(0);
    expect($(form, '[data-msg="form"]').textContent).toBe('dialog closed');
    expect($<HTMLButtonElement>(form, 'button[type="submit"]').disabled).toBe(false);
  });

  it('keeps a tray Pause when the user did not touch the mode radio', async () => {
    const { form, saved } = mount(config(), { currentMode: () => 'paused' });
    setValue(form, 'idle_after_minutes', '15');
    submit(form);
    await flush();
    expect(saved).toHaveLength(1);
    expect(saved[0]?.schedule.mode).toBe('paused');
  });

  it('lets the user override the mode even if the tray state differs', async () => {
    const { form, saved } = mount(config(), { currentMode: () => 'paused' });
    choose(form, 'mode', 'idle_only');
    submit(form);
    await flush();
    expect(saved).toHaveLength(1);
    expect(saved[0]?.schedule.mode).toBe('idle_only');
  });

  it('resets the mode baseline after a successful save', async () => {
    let mode: ScheduleMode = 'active';
    const { form, saved } = mount(config(), { currentMode: () => mode });

    choose(form, 'mode', 'paused');
    submit(form);
    await flush();
    expect(saved).toHaveLength(1);
    expect(saved[0]?.schedule.mode).toBe('paused');

    // The tray resumed the worker in the meantime; the mode radio is still
    // showing "Paused" because the form was never re-rendered.
    mode = 'active';
    setValue(form, 'idle_after_minutes', '15');
    submit(form);
    await flush();
    expect(saved).toHaveLength(2);
    expect(saved[1]?.schedule.mode).toBe('active');
  });

  it('warns instead of silently dropping an unsaved key on Save settings', async () => {
    const { form, saved, keys } = mount();
    $<HTMLInputElement>(form, '[data-key-input]').value = KEY;
    submit(form);
    await flush();
    expect(keys).toHaveLength(0);
    expect($<HTMLInputElement>(form, '[data-key-input]').value).toBe('');
    expect($(form, '[data-msg="key"]').textContent).toMatch(/Use Save key/);
    expect(JSON.stringify(saved)).not.toContain(KEY);
  });

  it('sends the API key only through onSetKey and clears the field', async () => {
    const { form, keys, saved } = mount();
    const input = $<HTMLInputElement>(form, '[data-key-input]');
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

  it('saves the key on Enter without submitting the form', async () => {
    const { form, keys, saved } = mount();
    const input = $<HTMLInputElement>(form, '[data-key-input]');
    input.value = KEY;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    await flush();
    expect(keys).toEqual([['openai', KEY]]);
    expect(saved).toHaveLength(0);
  });

  it('removes the stored key', async () => {
    const { form, deletedKeys } = mount();
    $(form, '[data-action="remove-key"]').click();
    await flush();
    expect(deletedKeys).toEqual(['openai']);
    expect($(form, '[data-live="key-state"]').textContent).toBe('No key stored');
    expect($(form, '[data-msg="key"]').textContent).toBe('Key removed.');
  });

  it('exposes the API key field accessibly', () => {
    const { form } = mount();
    const input = $<HTMLInputElement>(form, '[data-key-input]');
    expect(input.getAttribute('aria-label')).toBe('OpenAI API key');
    const describedBy = (input.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
    expect(describedBy.length).toBeGreaterThan(0);
    for (const id of describedBy) {
      expect(form.querySelector(`#${id}`)).not.toBeNull();
    }
  });

  it('labels the project ID textarea and the schedule/projects radio groups', () => {
    const { form } = mount();
    expect($(form, 'textarea[name="remote_projects"]').getAttribute('aria-label')).toBe(
      'Project IDs (comma or space separated)',
    );
    const legends = [...form.querySelectorAll('legend')].map((el) => el.textContent);
    expect(legends).toContain('When to contribute');
    expect(legends).toContain('Which projects');
  });
});
