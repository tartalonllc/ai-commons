import { fileURLToPath } from 'node:url';
import { checkTaskPayload, readJsonl } from '@ai-commons/project-sdk';
import { parse, ProjectDefinition, renderPrompt, TaskId } from '@ai-commons/protocol';
import type { TSchema } from 'typebox';
import Value from 'typebox/value';
import { describe, expect, it } from 'vitest';
import project from '../project.ts';
import { arxivTaskId, decodeXml, parseArxivFeed } from '../scripts/arxiv.ts';

const samplePath = fileURLToPath(new URL('../data/sample.jsonl', import.meta.url));

describe('abstract-classification project', () => {
  it('is a valid project definition', () => {
    expect(parse(ProjectDefinition, project).ok).toBe(true);
  });

  it('accepts a well-formed classification and rejects an off-list discipline', () => {
    const good = {
      primary_discipline: 'biology',
      secondary_topics: ['protein folding'],
      study_type: 'computational',
      contains_experiment: false,
      confidence: 0.8,
    };
    const schema = project.output_schema as TSchema;
    expect(Value.Check(schema, good)).toBe(true);
    expect(Value.Check(schema, { ...good, primary_discipline: 'alchemy' })).toBe(false);
    expect(Value.Check(schema, { ...good, secondary_topics: ['a', 'b', 'c', 'd', 'e', 'f'] })).toBe(
      false,
    );
  });

  it('sample records are valid tasks and render prompts', async () => {
    let count = 0;
    for await (const row of readJsonl(samplePath)) {
      const { id, ...payload } = row;
      expect(parse(TaskId, id).ok).toBe(true);
      expect(checkTaskPayload(project.input_schema, { payload })).toEqual([]);
      expect(renderPrompt(project.prompt, payload).user).toContain(String(payload['title']));
      count++;
    }
    expect(count).toBeGreaterThanOrEqual(10);
  });
});

describe('arXiv feed parsing', () => {
  const feed = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
    <entry>
      <id>http://arxiv.org/abs/2409.01234v2</id>
      <title>Proteins &amp; Folding:
        a &lt;Study&gt;</title>
      <summary>  We simulate
        folding &#x3B1;-helices.  </summary>
    </entry>
    <entry><id>http://arxiv.org/abs/hep-ph/0101001v1</id><title>Old</title><summary>S</summary></entry>
    <entry><id>x</id><title>No summary</title></entry>
  </feed>`;

  it('extracts, decodes, and normalizes entries', () => {
    expect(parseArxivFeed(feed)).toEqual([
      {
        id: 'arxiv_2409_01234v2',
        title: 'Proteins & Folding: a <Study>',
        abstract: 'We simulate folding α-helices.',
      },
      { id: 'arxiv_hep_ph_0101001v1', title: 'Old', abstract: 'S' },
    ]);
  });

  it('produces protocol-valid task ids', () => {
    expect(parse(TaskId, arxivTaskId('http://arxiv.org/abs/math/0211159v3')).ok).toBe(true);
  });

  it('leaves unknown entities intact', () => {
    expect(decodeXml('a &nbsp; b')).toBe('a &nbsp; b');
  });
});
