import { describe, expect, it } from 'vitest';
import { errorText, fmtInt, fmtUsd } from '../src/format.js';

describe('format', () => {
  it('formats money for small and normal amounts', () => {
    expect(fmtUsd(0)).toBe('$0.00');
    expect(fmtUsd(0.14)).toBe('$0.14');
    expect(fmtUsd(0.0042)).toBe('$0.0042');
    expect(fmtUsd(5)).toBe('$5.00');
  });

  it('formats negative amounts with a leading sign', () => {
    expect(fmtUsd(-5)).toBe('-$5.00');
  });

  it('shows a floor for amounts below one hundredth of a cent', () => {
    expect(fmtUsd(0.00001)).toBe('<$0.0001');
  });

  it('groups large amounts with two decimals', () => {
    expect(fmtUsd(12345.678)).toBe('$12,345.68');
  });

  it('rounds up to the cent just below the 4-decimal threshold', () => {
    expect(fmtUsd(0.00999)).toBe('$0.01');
  });

  it('returns an em dash for non-finite amounts', () => {
    expect(fmtUsd(NaN)).toBe('—');
    expect(fmtUsd(Infinity)).toBe('—');
    expect(fmtUsd(-Infinity)).toBe('—');
  });

  it('groups integers', () => {
    expect(fmtInt(318_481)).toBe('318,481');
  });

  it('returns an em dash for a non-finite integer', () => {
    expect(fmtInt(NaN)).toBe('—');
  });

  it('turns any rejection into readable text', () => {
    expect(errorText(new Error('boom'))).toBe('boom');
    expect(errorText('The worker is not running')).toBe('The worker is not running');
    expect(errorText({})).toBe('Something went wrong.');
  });
});
