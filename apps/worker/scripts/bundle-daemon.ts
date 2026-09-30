import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));

await build({
  absWorkingDir: root,
  entryPoints: ['src/daemon/entry.ts'],
  outfile: 'dist-daemon/worker-daemon.mjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  // Native addon: the desktop installer ships this package next to the bundle.
  external: ['@napi-rs/keyring'],
  // CommonJS dependencies (pino, sonic-boom) call require(); give the ESM bundle one.
  banner: {
    js: "import { createRequire as __aicCreateRequire } from 'node:module';\nconst require = __aicCreateRequire(import.meta.url);",
  },
  sourcemap: true,
  legalComments: 'external',
  logLevel: 'info',
});
