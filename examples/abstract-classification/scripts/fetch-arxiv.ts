// Fetches public arXiv abstracts (metadata is CC0) into JSONL.
// Usage: node scripts/fetch-arxiv.ts [--count 10000] [--out data/abstracts.jsonl]
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { parseArxivFeed, retryDelayMs, type AbstractRecord } from './arxiv.ts';

const API = 'https://export.arxiv.org/api/query';
const USER_AGENT = 'AI-Commons-demo/0.1 (open-source volunteer compute demo)';
const DELAY_MS = 3_000;
const MAX_PAGE = 1_000;
const MAX_RATE_LIMIT_RETRIES = 5;

const CATEGORIES = [
  'astro-ph.GA',
  'cond-mat.mtrl-sci',
  'hep-ph',
  'quant-ph',
  'physics.chem-ph',
  'q-bio.BM',
  'q-bio.NC',
  'cs.LG',
  'cs.CL',
  'math.PR',
  'stat.ME',
  'econ.EM',
  'eess.SP',
  'physics.ao-ph',
  'physics.med-ph',
  'physics.soc-ph',
];

const { values } = parseArgs({
  options: {
    count: { type: 'string', default: '10000' },
    out: { type: 'string', default: 'data/abstracts.jsonl' },
  },
});
const total = Number.parseInt(values.count, 10);
if (!Number.isInteger(total) || total < 1) throw new Error('--count must be a positive integer');

let lastRequest = 0;
async function fetchPage(category: string, start: number, size: number): Promise<AbstractRecord[]> {
  const url = `${API}?search_query=cat:${encodeURIComponent(category)}&start=${start}&max_results=${size}&sortBy=submittedDate&sortOrder=descending`;
  for (let attempt = 1; ; attempt++) {
    const wait = lastRequest + DELAY_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
    const response = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
    if (response.ok) return parseArxivFeed(await response.text());
    if (response.status === 429 && attempt <= MAX_RATE_LIMIT_RETRIES) {
      await sleep(retryDelayMs(response.headers.get('retry-after'), attempt));
      continue;
    }
    if (attempt >= 3 || response.status < 500) {
      throw new Error(`arXiv API ${response.status} for ${category} @${start}`);
    }
    await sleep(DELAY_MS * attempt * 2);
  }
}

await mkdir(dirname(values.out), { recursive: true });
let existing = '';
try {
  existing = await readFile(values.out, 'utf8');
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}
const existingRecords = existing
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line) as AbstractRecord);
const seen = new Set(existingRecords.map((record) => record.id));
if (existingRecords.length === 0) await writeFile(values.out, '');
const perCategory = Math.ceil(total / CATEGORIES.length);

for (const category of CATEGORIES) {
  let fetched = 0;
  let start = 0;
  let duplicatePages = 0;
  while (fetched < perCategory && seen.size < total) {
    const size = Math.min(MAX_PAGE, perCategory - fetched, total - seen.size);
    const page = await fetchPage(category, start, size);
    if (page.length === 0) break;
    start += page.length;
    const fresh = page.filter((r) => !seen.has(r.id)).slice(0, total - seen.size);
    for (const r of fresh) seen.add(r.id);
    fetched += fresh.length;
    duplicatePages = fresh.length === 0 ? duplicatePages + 1 : 0;
    if (fresh.length > 0) {
      await appendFile(values.out, fresh.map((r) => JSON.stringify(r)).join('\n') + '\n');
    }
    process.stdout.write(`${category}: ${fetched}  total: ${seen.size}/${total}\n`);
    if (duplicatePages >= 3) break;
  }
  if (seen.size >= total) break;
}

console.log(`Wrote ${seen.size} abstracts to ${values.out}`);
