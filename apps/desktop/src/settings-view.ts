import type {
  DaemonStatus,
  ProbeResult,
  ProviderConfig,
  ScheduleMode,
  WorkerConfig,
} from '@ai-commons/worker';
import { h, type Attrs } from './dom.js';
import { errorText, fmtInt } from './format.js';
import { connectionLabel } from './status-view.js';

const OLLAMA_DEFAULT = 'http://localhost:11434';
const DEFAULT_IDLE_MINUTES = 5;
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

export const CATEGORIES = [
  ['science', 'Science'],
  ['medicine', 'Medicine'],
  ['astronomy', 'Astronomy'],
  ['climate', 'Climate'],
  ['open_source', 'Open source'],
  ['history', 'History'],
  ['education', 'Education'],
] as const;
type Category = (typeof CATEGORIES)[number][0];

export interface SettingsHandlers {
  onSave: (config: WorkerConfig) => Promise<void>;
  onProbe: (id: string, endpoint: string) => Promise<ProbeResult>;
  onSetKey: (provider: string, key: string) => Promise<void>;
  onDeleteKey: (provider: string) => Promise<void>;
  confirm: (message: string) => Promise<boolean>;
  /**
   * The daemon's live schedule mode (e.g. a tray Pause), read at save time so an
   * untouched mode radio never clobbers it. Return undefined when unknown.
   */
  currentMode: () => ScheduleMode | undefined;
  /** REMOTE_DISCLOSURE, shown before any remote provider is enabled. */
  disclosure: string;
}

export type FormResult = { ok: true; config: WorkerConfig } | { ok: false; error: string };
type Model = { name: string; context_window?: number };
type Tone = 'ok' | 'warn' | 'danger' | 'neutral';

// ---- reading ----

function field(form: HTMLFormElement, name: string): HTMLInputElement | HTMLTextAreaElement {
  const el = form.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`);
  if (!el) throw new Error(`Missing form field ${name}`);
  return el;
}

function checked(form: HTMLFormElement, name: string): boolean {
  return form.querySelector<HTMLInputElement>(`input[name="${name}"]`)?.checked ?? false;
}

function radio(form: HTMLFormElement, name: string): string {
  return form.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value ?? '';
}

function checkedBoxes(form: HTMLFormElement, name: string): HTMLInputElement[] {
  return [...form.querySelectorAll<HTMLInputElement>(`input[name="${name}"]:checked`)];
}

function isCategory(value: string): value is Category {
  return CATEGORIES.some(([c]) => c === value);
}

function modelWithContextWindow(el: HTMLInputElement): Model {
  const cw = Number(el.dataset.contextWindow);
  return Number.isInteger(cw) && cw > 0
    ? { name: el.value, context_window: cw }
    : { name: el.value };
}

/** Pure DOM → WorkerConfig. The daemon validates again; this gives friendlier messages. */
export function readSettingsForm(form: HTMLFormElement, base: WorkerConfig): FormResult {
  const coordinator = field(form, 'coordinator_url').value.trim();
  if (!coordinator) return { ok: false, error: 'Enter the coordinator URL.' };

  const daily = Number(field(form, 'daily_usd').value);
  const monthly = Number(field(form, 'monthly_usd').value);
  if (!Number.isFinite(daily) || daily < 0 || !Number.isFinite(monthly) || monthly < 0) {
    return { ok: false, error: 'API limits must be zero or positive numbers.' };
  }
  if (daily > monthly) {
    return { ok: false, error: 'The daily API limit cannot exceed the monthly limit.' };
  }

  const mode = radio(form, 'mode');
  if (mode !== 'active' && mode !== 'idle_only' && mode !== 'paused') {
    return { ok: false, error: 'Choose a schedule.' };
  }
  const idleAfter = Number(field(form, 'idle_after_minutes').value);
  if (!Number.isInteger(idleAfter) || idleAfter < 1 || idleAfter > 240) {
    return { ok: false, error: 'Idle time must be a whole number of minutes from 1 to 240.' };
  }

  let categories: WorkerConfig['projects']['categories'] = 'all';
  if (radio(form, 'categories_scope') === 'selected') {
    const picked = checkedBoxes(form, 'category')
      .map((el) => el.value)
      .filter(isCategory);
    if (picked.length === 0) return { ok: false, error: 'Pick at least one project category.' };
    categories = picked;
  }

  let allowRemote: WorkerConfig['projects']['allow_remote_for_projects'] = 'all';
  if (radio(form, 'remote_scope') !== 'all') {
    const raw = field(form, 'remote_projects')
      .value.split(/[\s,]+/)
      .filter((id) => id.length > 0);
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const id of raw) {
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    const bad = ids.find((id) => !PROJECT_ID_PATTERN.test(id));
    if (bad) {
      return {
        ok: false,
        error: `"${bad}" is not a valid project ID (lowercase letters, numbers and hyphens only).`,
      };
    }
    allowRemote = ids;
  }

  const ollamaBase = base.providers.find((p) => p.id === 'ollama');
  const ollama: ProviderConfig = {
    ...ollamaBase,
    id: 'ollama',
    kind: 'local',
    enabled: checked(form, 'ollama.enabled'),
    endpoint: field(form, 'ollama.endpoint').value.trim() || OLLAMA_DEFAULT,
    models: checkedBoxes(form, 'ollama.model').map(modelWithContextWindow),
  };

  const openaiBase = base.providers.find((p) => p.id === 'openai');
  const openaiEnabled = checked(form, 'openai.enabled');
  const model = field(form, 'openai.model').value.trim();
  const inPrice = field(form, 'openai.input_price').value.trim();
  const outPrice = field(form, 'openai.output_price').value.trim();
  let openai: ProviderConfig | undefined;
  if (openaiEnabled || model || openaiBase) {
    const priced = model !== '' && inPrice !== '' && outPrice !== '';
    if (openaiEnabled && !priced) {
      return {
        ok: false,
        error: 'OpenAI needs a model and its prices per 1M input and output tokens.',
      };
    }
    const input = Number(inPrice);
    const output = Number(outPrice);
    if (priced && (!(input > 0) || !(output > 0))) {
      return { ok: false, error: 'Prices must be greater than zero for a paid model.' };
    }
    // Only models[0] and its pricing entry are driven by the form; any other
    // configured models and prices (added some other way) survive untouched.
    const extraModels = (openaiBase?.models ?? []).slice(1);
    const models = model ? [{ name: model }, ...extraModels] : extraModels;
    const pricing = priced
      ? {
          ...openaiBase?.pricing,
          [model]: { input_per_mtok: input, output_per_mtok: output },
        }
      : openaiBase?.pricing;
    openai = {
      id: 'openai',
      kind: 'remote',
      enabled: openaiEnabled,
      models,
      ...(openaiBase?.endpoint === undefined ? {} : { endpoint: openaiBase.endpoint }),
      ...(pricing ? { pricing } : {}),
    };
  }

  const others = base.providers.filter((p) => p.id !== 'ollama' && p.id !== 'openai');
  const config: WorkerConfig = {
    ...base,
    coordinator_url: coordinator,
    providers: [ollama, ...(openai ? [openai] : []), ...others],
    limits: { ...base.limits, api: { daily_usd: daily, monthly_usd: monthly } },
    schedule: { mode, idle_after_minutes: idleAfter },
    projects: { categories, allow_remote_for_projects: allowRemote },
  };
  // The coordinator assigns worker_id on registration; the daemon restores it
  // itself when the coordinator URL is unchanged. The settings form never sends it.
  delete config.worker_id;
  return { ok: true, config };
}

// ---- rendering ----

function input(name: string, value: string, attrs: Attrs = {}): HTMLInputElement {
  return h('input', { name, value, spellcheck: 'false', ...attrs });
}

function labeled(text: string, control: HTMLElement): HTMLElement {
  return h('label', { class: 'field' }, h('span', {}, text), control);
}

function choice(
  type: 'radio' | 'checkbox',
  name: string,
  value: string,
  label: string,
  on: boolean,
): HTMLElement {
  return h('label', { class: 'choice' }, h('input', { type, name, value, checked: on }), label);
}

function row(label: string, value: HTMLElement | string): HTMLElement {
  return h(
    'div',
    { class: 'row' },
    h('span', { class: 'label' }, label),
    h('span', { class: 'value' }, value),
  );
}

function actionButton(label: string, action: string, cls = 'secondary'): HTMLButtonElement {
  return h('button', { type: 'button', class: cls, 'data-action': action }, label);
}

function setMsg(el: HTMLElement, text: string, tone: Tone = 'neutral'): void {
  el.textContent = text;
  el.className = `form-msg ${tone}`;
}

function dedupeByName(models: readonly Model[]): Model[] {
  const seen = new Set<string>();
  const out: Model[] = [];
  for (const m of models) {
    if (seen.has(m.name)) continue;
    seen.add(m.name);
    out.push(m);
  }
  return out;
}

function modelList(models: Model[], selected: ReadonlySet<string>): HTMLElement {
  if (models.length === 0) {
    return h(
      'p',
      { class: 'muted', 'data-section': 'ollama-models' },
      'No models yet. Click "Detect models".',
    );
  }
  return h(
    'div',
    { class: 'checklist', 'data-section': 'ollama-models' },
    ...models.map((m) =>
      h(
        'label',
        { class: 'choice' },
        h('input', {
          type: 'checkbox',
          name: 'ollama.model',
          value: m.name,
          checked: selected.has(m.name),
          'data-context-window': m.context_window,
        }),
        m.context_window ? `${m.name} (${fmtInt(m.context_window)} tokens)` : m.name,
      ),
    ),
  );
}

export function renderSettings(
  initial: WorkerConfig,
  status: DaemonStatus | undefined,
  handlers: SettingsHandlers,
): HTMLFormElement {
  let current = initial;
  // Baseline for "did the user touch the mode radio". Reset after each
  // successful save so the next save compares against the saved mode, not
  // the mode the form happened to render with.
  let initialMode = initial.schedule.mode;
  const ollama = initial.providers.find((p) => p.id === 'ollama');
  const openai = initial.providers.find((p) => p.id === 'openai');
  const openaiModel = openai?.models[0]?.name ?? '';
  const price = openaiModel ? openai?.pricing?.[openaiModel] : undefined;
  const allowRemote = initial.projects.allow_remote_for_projects;
  const cats = initial.projects.categories;
  const hasKey = status?.providers.find((p) => p.id === 'openai')?.has_key ?? false;

  const probeMsg = h('span', { class: 'form-msg neutral', role: 'status', 'data-msg': 'probe' });
  const keyMsg = h('span', { class: 'form-msg neutral', role: 'status', 'data-msg': 'key' });
  const formMsg = h('span', { class: 'form-msg neutral', role: 'status', 'data-msg': 'form' });
  const detect = actionButton('Detect models', 'detect');
  const keyStateId = 'openai-key-state';
  const keyNoteId = 'openai-key-note';
  const keyState = h(
    'span',
    { class: 'muted', 'data-live': 'key-state', id: keyStateId },
    hasKey ? 'Key stored ✓' : 'No key stored',
  );
  const keyNote = h(
    'small',
    { class: 'muted', id: keyNoteId },
    'Stored in Windows Credential Manager. Never sent to the coordinator.',
  );
  const keyInput = h('input', {
    type: 'password',
    autocomplete: 'new-password',
    spellcheck: 'false',
    placeholder: hasKey ? 'Paste a new key to replace it' : 'sk-…',
    'aria-label': 'OpenAI API key',
    'aria-describedby': `${keyStateId} ${keyNoteId}`,
    'data-key-input': true,
  });
  const saveKey = actionButton('Save key', 'save-key');
  const removeKey = actionButton('Remove key', 'remove-key');
  const submitButton = h('button', { type: 'submit', class: 'primary' }, 'Save settings');

  const form = h(
    'form',
    { class: 'settings', novalidate: true },
    h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Coordinator'),
      labeled(
        'Coordinator URL',
        input('coordinator_url', initial.coordinator_url, { type: 'url' }),
      ),
      row(
        'Connection',
        h('span', { 'data-live': 'connection' }, status ? connectionLabel(status).text : 'Unknown'),
      ),
      row(
        'Worker ID',
        h('code', {}, status?.worker_id ?? initial.worker_id ?? 'Not registered yet'),
      ),
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Providers'),
      h('h3', {}, 'Ollama (local)'),
      choice(
        'checkbox',
        'ollama.enabled',
        'on',
        'Use Ollama on this computer',
        ollama?.enabled ?? false,
      ),
      labeled('Endpoint', input('ollama.endpoint', ollama?.endpoint ?? OLLAMA_DEFAULT)),
      h('div', { class: 'actions' }, detect, probeMsg),
      modelList(ollama?.models ?? [], new Set(ollama?.models.map((m) => m.name))),
      h('h3', {}, 'OpenAI (paid API)'),
      choice('checkbox', 'openai.enabled', 'on', 'Use my OpenAI API key', openai?.enabled ?? false),
      h(
        'div',
        { class: 'field' },
        h('span', {}, 'API key'),
        keyState,
        keyInput,
        h('div', { class: 'actions' }, saveKey, removeKey, keyMsg),
        keyNote,
      ),
      labeled('Model', input('openai.model', openaiModel, { placeholder: 'e.g. gpt-4o-mini' })),
      h(
        'div',
        { class: 'grid-2' },
        labeled(
          'Input $ / 1M tokens',
          input('openai.input_price', price ? String(price.input_per_mtok) : '', {
            type: 'number',
            min: 0,
            step: 'any',
          }),
        ),
        labeled(
          'Output $ / 1M tokens',
          input('openai.output_price', price ? String(price.output_per_mtok) : '', {
            type: 'number',
            min: 0,
            step: 'any',
          }),
        ),
      ),
      h(
        'fieldset',
        {},
        h('legend', {}, 'Projects allowed to use paid APIs'),
        choice('radio', 'remote_scope', 'all', 'All approved projects', allowRemote === 'all'),
        choice('radio', 'remote_scope', 'list', 'Only these project IDs', allowRemote !== 'all'),
        h(
          'textarea',
          {
            name: 'remote_projects',
            rows: 2,
            spellcheck: 'false',
            'aria-label': 'Project IDs (comma or space separated)',
          },
          allowRemote === 'all' ? '' : allowRemote.join(', '),
        ),
      ),
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Limits'),
      h(
        'div',
        { class: 'grid-2' },
        labeled(
          'Daily API limit (USD)',
          input('daily_usd', String(initial.limits.api.daily_usd), {
            type: 'number',
            min: 0,
            step: '0.01',
          }),
        ),
        labeled(
          'Monthly API limit (USD)',
          input('monthly_usd', String(initial.limits.api.monthly_usd), {
            type: 'number',
            min: 0,
            step: '0.01',
          }),
        ),
      ),
      h(
        'p',
        { class: 'muted' },
        '$0 means no paid API calls. Limits are enforced on this computer, never by the coordinator.',
      ),
      h(
        'div',
        { class: 'grid-2' },
        labeled(
          'CPU limit (%)',
          input('cpu_percent', String(initial.limits.local.cpu_percent), {
            type: 'number',
            disabled: true,
          }),
        ),
        labeled(
          'GPU preference (%)',
          input('gpu_percent', String(initial.limits.local.gpu_percent), {
            type: 'number',
            disabled: true,
          }),
        ),
      ),
      h('p', { class: 'muted' }, 'CPU and GPU limits are recorded but not yet enforced.'),
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Schedule'),
      h(
        'fieldset',
        {},
        h('legend', {}, 'When to contribute'),
        choice('radio', 'mode', 'active', 'Always', initialMode === 'active'),
        choice(
          'radio',
          'mode',
          'idle_only',
          'Only while this computer is idle',
          initialMode === 'idle_only',
        ),
        choice('radio', 'mode', 'paused', 'Paused', initialMode === 'paused'),
        labeled(
          'Idle after (minutes without keyboard or mouse input)',
          input(
            'idle_after_minutes',
            String(initial.schedule.idle_after_minutes ?? DEFAULT_IDLE_MINUTES),
            { type: 'number', min: 1, max: 240, step: 1 },
          ),
        ),
      ),
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Projects'),
      h(
        'fieldset',
        {},
        h('legend', {}, 'Which projects'),
        choice('radio', 'categories_scope', 'all', 'All approved projects', cats === 'all'),
        choice('radio', 'categories_scope', 'selected', 'Selected categories', cats !== 'all'),
        h(
          'div',
          { class: 'checklist' },
          ...CATEGORIES.map(([value, label]) =>
            choice('checkbox', 'category', value, label, cats !== 'all' && cats.includes(value)),
          ),
        ),
      ),
    ),
    h('div', { class: 'save-bar' }, submitButton, formMsg),
  );

  detect.addEventListener('click', () => {
    void (async () => {
      detect.disabled = true;
      setMsg(probeMsg, 'Checking…');
      try {
        const endpoint = field(form, 'ollama.endpoint').value.trim() || OLLAMA_DEFAULT;
        const result = await handlers.onProbe('ollama', endpoint);
        if (!result.ok) {
          setMsg(probeMsg, result.message ?? 'Ollama is not reachable.', 'danger');
          return;
        }
        const deduped = dedupeByName(result.models);
        const selected = new Set(checkedBoxes(form, 'ollama.model').map((el) => el.value));
        const known = [...form.querySelectorAll<HTMLInputElement>('input[name="ollama.model"]')]
          .filter((el) => !deduped.some((m) => m.name === el.value))
          .map(modelWithContextWindow);
        form
          .querySelector('[data-section="ollama-models"]')
          ?.replaceWith(modelList([...deduped, ...known], selected));
        setMsg(probeMsg, `Found ${deduped.length} model(s).`, 'ok');
      } catch (error) {
        setMsg(probeMsg, errorText(error), 'danger');
      } finally {
        detect.disabled = false;
      }
    })();
  });

  const submitKey = async () => {
    const key = keyInput.value.trim();
    keyInput.value = ''; // never leave a key sitting in the DOM
    if (!key) {
      setMsg(keyMsg, 'Paste a key first.', 'warn');
      return;
    }
    try {
      await handlers.onSetKey('openai', key);
      keyState.textContent = 'Key stored ✓';
      setMsg(keyMsg, 'Key saved.', 'ok');
    } catch (error) {
      setMsg(keyMsg, errorText(error), 'danger');
    }
  };
  saveKey.addEventListener('click', () => void submitKey());
  keyInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault(); // Enter here saves the key, not the whole form
    void submitKey();
  });
  removeKey.addEventListener('click', () => {
    void (async () => {
      try {
        await handlers.onDeleteKey('openai');
        keyState.textContent = 'No key stored';
        setMsg(keyMsg, 'Key removed.', 'ok');
      } catch (error) {
        setMsg(keyMsg, errorText(error), 'danger');
      }
    })();
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void (async () => {
      // Typing a key and hitting Save settings (instead of Save key) must never
      // silently drop it, and must never leave it sitting in the DOM either.
      if (keyInput.value.trim() !== '') {
        keyInput.value = '';
        setMsg(keyMsg, 'Use Save key to store the API key', 'warn');
      }

      const result = readSettingsForm(form, current);
      if (!result.ok) {
        setMsg(formMsg, result.error, 'danger');
        return;
      }
      // Don't undo a tray Pause (or other out-of-band mode change): only trust
      // the radio when the user actually touched it.
      if (radio(form, 'mode') === initialMode) {
        result.config.schedule.mode = handlers.currentMode() ?? result.config.schedule.mode;
      }

      submitButton.disabled = true;
      try {
        const wasRemote = current.providers.some((p) => p.kind === 'remote' && p.enabled);
        const nowRemote = result.config.providers.some((p) => p.kind === 'remote' && p.enabled);
        if (nowRemote && !wasRemote && !(await handlers.confirm(handlers.disclosure))) {
          setMsg(formMsg, 'Not saved: the paid provider was not confirmed.', 'warn');
          return;
        }
        await handlers.onSave(result.config);
        current = result.config;
        initialMode = result.config.schedule.mode;
        setMsg(formMsg, 'Settings saved.', 'ok');
      } catch (error) {
        setMsg(formMsg, errorText(error), 'danger');
      } finally {
        submitButton.disabled = false;
      }
    })();
  });

  return form;
}
