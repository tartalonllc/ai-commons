import type { JsonObject } from './common.js';
import type { PromptTemplate } from './project.js';

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export interface RenderedPrompt {
  system: string;
  user: string;
}

export class PromptRenderError extends Error {
  constructor(readonly missingFields: string[]) {
    super(`Prompt references missing payload fields: ${missingFields.join(', ')}`);
    this.name = 'PromptRenderError';
  }
}

export function templatePlaceholders(template: string): string[] {
  return [...new Set(Array.from(template.matchAll(PLACEHOLDER), (m) => m[1] as string))];
}

function stringify(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Substitutes `{{field}}` with top-level payload values. Single pass, so
 * payload text that itself contains `{{...}}` is never re-expanded.
 */
export function renderPrompt(template: PromptTemplate, payload: JsonObject): RenderedPrompt {
  const missing = [
    ...templatePlaceholders(template.system),
    ...templatePlaceholders(template.user),
  ].filter((field) => !Object.hasOwn(payload, field) || payload[field] === undefined);
  if (missing.length > 0) throw new PromptRenderError([...new Set(missing)]);

  const fill = (text: string) =>
    text.replace(PLACEHOLDER, (_match, field: string) => stringify(payload[field]));
  return { system: fill(template.system), user: fill(template.user) };
}
