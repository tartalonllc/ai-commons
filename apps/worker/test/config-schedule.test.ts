// apps/worker/test/config-schedule.test.ts
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEFAULT_IDLE_AFTER_MINUTES,
  defaultConfig,
  validateConfig,
} from '../src/config.js';

function withIdle(value: unknown) {
  return { ...defaultConfig(), schedule: { mode: 'idle_only', idle_after_minutes: value } };
}

describe('schedule.idle_after_minutes', () => {
  it('is optional and defaults to 5 minutes', () => {
    expect(validateConfig(defaultConfig()).schedule.idle_after_minutes).toBeUndefined();
    expect(DEFAULT_IDLE_AFTER_MINUTES).toBe(5);
  });

  it('accepts whole minutes from 1 to 240', () => {
    expect(validateConfig(withIdle(1)).schedule.idle_after_minutes).toBe(1);
    expect(validateConfig(withIdle(240)).schedule.idle_after_minutes).toBe(240);
  });

  it('rejects out-of-range and fractional values', () => {
    for (const value of [0, 241, 2.5, '5']) {
      expect(() => validateConfig(withIdle(value))).toThrow(ConfigError);
    }
  });
});
