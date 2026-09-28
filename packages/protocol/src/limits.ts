export const PROTOCOL_VERSION = '0.1.0';

export const API_PREFIX = '/api/v1';

export const LIMITS = {
  maxPayloadBytes: 1_048_576,
  maxResultBytes: 32_768,
  maxTaskRuntimeMs: 10 * 60_000,
  leaseDurationMs: 15 * 60_000,
  heartbeatIntervalMs: 60_000,
  maxTasksPerIngestBatch: 1_000,
  maxOutputTokens: 32_768,
  maxReplicationFactor: 5,
  maxPromptTemplateChars: 32_768,
  maxFailureMessageChars: 500,
} as const;
