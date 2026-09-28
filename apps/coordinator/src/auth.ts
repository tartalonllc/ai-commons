import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { HttpError } from './errors.js';

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Constant-time comparison of two strings via their SHA-256 digests (equal length). */
export function safeEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a, 'utf8').digest();
  const db = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(da, db);
}

export function bearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  const match = header === undefined ? null : /^Bearer\s+(\S+)$/i.exec(header);
  if (!match?.[1]) throw new HttpError('unauthorized', 'Missing bearer token');
  return match[1];
}

export function requireAdmin(request: FastifyRequest, adminToken: string): void {
  if (!safeEqual(bearerToken(request), adminToken)) {
    throw new HttpError('unauthorized', 'Invalid admin token');
  }
}
