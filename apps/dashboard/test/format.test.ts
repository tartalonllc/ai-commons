import { describe, expect, it } from 'vitest';
import {
  formatCount,
  formatHours,
  formatLabel,
  formatPercent,
  formatRelativeTime,
  formatUsd,
} from '../src/format.js';
import { NOW } from './fixtures.js';

describe('formatCount', () => {
  it('groups small numbers and compacts large ones', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(8214)).toBe('8,214');
    expect(formatCount(99_999)).toBe('99,999');
    expect(formatCount(318_481)).toBe('318.5K');
    expect(formatCount(14_800_000)).toBe('14.8M');
  });
});

describe('formatUsd', () => {
  it('shows cents, sub-cent amounts, and whole dollars for large values', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.004)).toBe('<$0.01');
    expect(formatUsd(7.84)).toBe('$7.84');
    expect(formatUsd(4381.2)).toBe('$4,381');
  });
});

describe('formatHours', () => {
  it('scales from minutes to hours', () => {
    expect(formatHours(0)).toBe('0 h');
    expect(formatHours(0.0001)).toBe('<1 min');
    expect(formatHours(0.7)).toBe('42 min');
    expect(formatHours(6.33)).toBe('6.3 h');
    expect(formatHours(1204.4)).toBe('1,204 h');
  });
});

describe('formatPercent', () => {
  it('floors so unfinished work never shows 100%', () => {
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(0.73148)).toBe('73.1%');
    expect(formatPercent(0.9999)).toBe('99.9%');
    expect(formatPercent(1)).toBe('100%');
    expect(formatPercent(1.5)).toBe('100%');
    expect(formatPercent(-1)).toBe('0%');
  });
});

describe('formatRelativeTime', () => {
  const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

  it('describes elapsed time', () => {
    expect(formatRelativeTime(ago(2_000), NOW)).toBe('just now');
    expect(formatRelativeTime(ago(42_000), NOW)).toBe('42s ago');
    expect(formatRelativeTime(ago(5 * 60_000), NOW)).toBe('5 min ago');
    expect(formatRelativeTime(ago(3 * 3_600_000), NOW)).toBe('3 h ago');
    expect(formatRelativeTime(ago(49 * 3_600_000), NOW)).toBe('2 d ago');
  });

  it('treats future timestamps as now and garbage as unknown', () => {
    expect(formatRelativeTime(ago(-10_000), NOW)).toBe('just now');
    expect(formatRelativeTime('not a date', NOW)).toBe('unknown');
  });
});

it('formats enum labels', () => {
  expect(formatLabel('open_source')).toBe('Open source');
  expect(formatLabel('text_generation')).toBe('Text generation');
});
