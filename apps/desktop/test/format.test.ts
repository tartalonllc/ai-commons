import { describe, expect, it } from 'vitest';
import { errorText, fmtInt, fmtUsd } from '../src/format.js';

describe('format', () => {
  it('formats money for small and normal amounts', () => {
    expect(fmtUsd(0)).toBe('$0.00');
    expect(fmtUsd(0.14)).toBe('$0.14');
    expect(fmtUsd(0.0042)).toBe('$0.0042');
    expect(fmtUsd(5)).toBe('$5.00');
  });

  it('groups integers', () => {
    expect(fmtInt(318_481)).toBe('318,481');
  });

  it('turns any rejection into readable text', () => {
    expect(errorText(new Error('boom'))).toBe('boom');
    expect(errorText('The worker is not running')).toBe('The worker is not running');
    expect(errorText({})).toBe('Something went wrong.');
  });
});
