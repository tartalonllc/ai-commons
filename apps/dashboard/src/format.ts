const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const oneDecimal = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const cents = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const dollars = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

/** 318,481 · 14.8M — grouped below 100k, compact above. */
export function formatCount(value: number): string {
  return Math.abs(value) < 100_000 ? integer.format(value) : compact.format(value);
}

export function formatInteger(value: number): string {
  return integer.format(value);
}

/** $0.14 · <$0.01 · $4,381 */
export function formatUsd(value: number): string {
  if (value === 0) return cents.format(0);
  if (value < 0.01) return '<$0.01';
  return value < 1_000 ? cents.format(value) : dollars.format(value);
}

/** 42 min · 6.3 h · 1,204 h */
export function formatHours(hours: number): string {
  if (hours === 0) return '0 h';
  const minutes = hours * 60;
  if (minutes < 1) return '<1 min';
  if (hours < 1) return `${Math.floor(minutes)} min`;
  if (hours < 100) return `${oneDecimal.format(hours)} h`;
  return `${integer.format(hours)} h`;
}

/**
 * Floors to one decimal so an unfinished project never displays as 100%.
 */
export function formatPercent(fraction: number): string {
  const clamped = Math.min(1, Math.max(0, fraction));
  const tenths = Math.floor(clamped * 1000) / 10;
  return `${tenths % 1 === 0 ? tenths.toFixed(0) : tenths.toFixed(1)}%`;
}

/** "just now", "42s ago", "5 min ago", "3 h ago", "2 d ago" */
export function formatRelativeTime(iso: string, now: Date): string {
  const seconds = Math.floor((now.getTime() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return 'unknown';
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

export function formatLabel(value: string): string {
  const spaced = value.replaceAll('_', ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
