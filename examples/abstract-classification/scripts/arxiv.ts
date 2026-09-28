export interface AbstractRecord {
  id: string;
  title: string;
  abstract: string;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

export function decodeXml(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (match, entity: string) => {
      if (entity.startsWith('#x')) return String.fromCodePoint(parseInt(entity.slice(2), 16));
      if (entity.startsWith('#')) return String.fromCodePoint(parseInt(entity.slice(1), 10));
      return ENTITIES[entity] ?? match;
    });
}

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();

function tag(xml: string, name: string): string | undefined {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return match?.[1];
}

/** Turns an arXiv abs URL into a task-id-safe identifier: `arxiv_2409_01234v1`. */
export function arxivTaskId(absUrl: string): string {
  const raw = absUrl.replace(/^https?:\/\/arxiv\.org\/abs\//, '');
  return `arxiv_${raw.replace(/[^A-Za-z0-9]+/g, '_')}`.slice(0, 64);
}

/** Minimal Atom parser for arXiv API responses (no dependencies). */
export function parseArxivFeed(xml: string): AbstractRecord[] {
  const records: AbstractRecord[] = [];
  for (const [, entry] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    if (!entry) continue;
    const id = tag(entry, 'id');
    const title = tag(entry, 'title');
    const summary = tag(entry, 'summary');
    if (!id || !title || !summary) continue;
    records.push({
      id: arxivTaskId(collapse(decodeXml(id))),
      title: collapse(decodeXml(title)),
      abstract: collapse(decodeXml(summary)),
    });
  }
  return records;
}
