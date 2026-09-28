import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { ConfigError } from './config.js';

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Serves the built dashboard at `/`. Vite emits content-hashed files under
 * `assets/`, so those are cached forever; everything else is revalidated.
 */
export async function registerDashboard(app: FastifyInstance, dir: string): Promise<void> {
  const root = resolve(dir);
  if (!existsSync(join(root, 'index.html'))) {
    throw new ConfigError(`DASHBOARD_DIR does not contain index.html: ${root}`);
  }
  const assetsDir = `${sep}assets${sep}`;

  await app.register(fastifyStatic, {
    root,
    prefix: '/',
    index: ['index.html'],
    list: false,
    dotfiles: 'deny',
    cacheControl: false,
    setHeaders(reply, path) {
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header(
        'Cache-Control',
        path.includes(assetsDir) ? 'public, max-age=31536000, immutable' : 'no-cache',
      );
      if (path.endsWith('.html')) {
        reply.header('Content-Security-Policy', CONTENT_SECURITY_POLICY);
        reply.header('Referrer-Policy', 'no-referrer');
      }
    },
  });
}
