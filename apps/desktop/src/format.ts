export function fmtUsd(n: number): string {
  if (n === 0) return '$0.00';
  return `$${n.toFixed(n < 0.01 ? 4 : 2)}`;
}

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** Tauri rejects `invoke` with the Rust error string; everything else is an Error. */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string' && error.length > 0) return error;
  return 'Something went wrong.';
}
