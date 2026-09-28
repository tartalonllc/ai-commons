import { describe, expect, it } from 'vitest';
import { PromptRenderError, renderPrompt, templatePlaceholders } from '../src/index.js';

describe('renderPrompt', () => {
  const template = { system: 'Classify.', user: 'Title: {{title}}\nAbstract: {{ abstract }}' };

  it('fills placeholders from the payload', () => {
    const rendered = renderPrompt(template, { title: 'T', abstract: 'A' });
    expect(rendered).toEqual({ system: 'Classify.', user: 'Title: T\nAbstract: A' });
  });

  it('serializes non-string values as JSON', () => {
    const rendered = renderPrompt({ system: '', user: '{{tags}}' }, { tags: ['a', 'b'] });
    expect(rendered.user).toBe('["a","b"]');
  });

  it('does not re-expand placeholders that appear inside payload text', () => {
    const rendered = renderPrompt(template, { title: '{{abstract}}', abstract: 'secret' });
    expect(rendered.user).toBe('Title: {{abstract}}\nAbstract: secret');
  });

  it('throws listing every missing field', () => {
    expect(() => renderPrompt(template, { title: 'T' })).toThrow(PromptRenderError);
    try {
      renderPrompt({ system: '{{a}}', user: '{{b}} {{a}}' }, {});
    } catch (error) {
      expect((error as PromptRenderError).missingFields).toEqual(['a', 'b']);
    }
  });

  it('ignores inherited properties such as __proto__ lookups', () => {
    expect(() => renderPrompt({ system: '', user: '{{constructor}}' }, {})).toThrow(
      PromptRenderError,
    );
  });

  it('lists unique placeholders', () => {
    expect(templatePlaceholders('{{a}} {{b}} {{ a }}')).toEqual(['a', 'b']);
  });
});
