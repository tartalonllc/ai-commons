import pino, { type DestinationStream, type Level, type Logger } from 'pino';

export type { Logger };

/**
 * Defense in depth: code never passes secrets or payloads to the logger, but
 * any field with these names is censored if one slips through.
 */
export const REDACT_PATHS = [
  'authorization',
  'Authorization',
  '*.authorization',
  '*.Authorization',
  'headers.authorization',
  'api_key',
  '*.api_key',
  'apiKey',
  '*.apiKey',
  'secret',
  '*.secret',
  'worker_secret',
  '*.worker_secret',
  'token',
  '*.token',
  'payload',
  '*.payload',
  'prompt',
  '*.prompt',
];

export function createLogger(level: string, destination?: DestinationStream): Logger {
  const options = {
    level,
    base: { app: 'aicommons-worker' },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  };
  return destination ? pino(options, destination) : pino(options, pino.destination(2));
}

export function createFileAndStderrLogger(level: string, logFile: string): Logger {
  const streams = pino.multistream([
    { level: level as Level, stream: pino.destination(2) },
    { level: level as Level, stream: pino.destination({ dest: logFile, mkdir: true }) },
  ]);
  return createLogger(level, streams);
}

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi,
];

/** Masks credential-like substrings in free text before it is logged or sent upstream. */
export function scrubSecrets(text: string, knownSecrets: readonly string[] = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (secret.length >= 4) out = out.split(secret).join('[redacted]');
  }
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]');
  return out;
}
