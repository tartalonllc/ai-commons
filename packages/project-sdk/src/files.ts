import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import type { JsonObject, ProjectDefinition } from '@ai-commons/protocol';
import { defineProject } from './define.js';

/** Loads and validates a JSON project manifest. */
export async function loadProjectManifest(path: string): Promise<ProjectDefinition> {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  return defineProject(value as ProjectDefinition);
}

export class JsonlParseError extends Error {
  constructor(
    readonly line: number,
    message: string,
  ) {
    super(`JSONL line ${line}: ${message}`);
    this.name = 'JsonlParseError';
  }
}

/** Streams JSON objects from a JSONL file, skipping blank lines. */
export async function* readJsonl(path: string): AsyncGenerator<JsonObject> {
  const lines = createInterface({
    input: createReadStream(path, 'utf8'),
    crlfDelay: Infinity,
  });
  let lineNo = 0;
  for await (const line of lines) {
    lineNo++;
    if (line.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new JsonlParseError(lineNo, 'invalid JSON');
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new JsonlParseError(lineNo, 'expected a JSON object');
    }
    yield value as JsonObject;
  }
}
