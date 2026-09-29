import { describe, expect, it } from 'vitest';
import * as commands from '../src/commands.js';
import { REMOTE_DISCLOSURE } from '../src/disclosure.js';

describe('REMOTE_DISCLOSURE', () => {
  it('is shared by the CLI and the desktop app', () => {
    expect(commands.REMOTE_DISCLOSURE).toBe(REMOTE_DISCLOSURE);
    expect(REMOTE_DISCLOSURE).toMatch(/full task input/);
    expect(REMOTE_DISCLOSURE).toMatch(/local_models_only/);
  });
});
