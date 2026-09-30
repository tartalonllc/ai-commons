// apps/desktop/scripts/stage-runtime.ts
// Copies the Node runtime, the bundled worker daemon and the keyring native addon
// into src-tauri/runtime/, which Tauri ships as resources. Windows x64 only for now.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const runtime = join(here, '..', 'src-tauri', 'runtime');
const workerDir = join(here, '..', '..', 'worker');
const bundle = join(workerDir, 'dist-daemon', 'worker-daemon.mjs');
const bundleMap = join(workerDir, 'dist-daemon', 'worker-daemon.mjs.map');

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error(
    `Staging supports Windows x64 only (running ${process.platform}-${process.arch}).`,
  );
}
const major = Number(process.versions.node.split('.')[0]);
if (major !== 24) {
  throw new Error(
    `Stage with Node 24: the running node binary is what gets shipped (this is ${process.version}).`,
  );
}
if (!existsSync(bundle)) {
  throw new Error(
    'Missing worker daemon bundle. Run "pnpm --filter @ai-commons/worker bundle:daemon".',
  );
}

for (const entry of ['node.exe', 'daemon'])
  rmSync(join(runtime, entry), { recursive: true, force: true });
mkdirSync(join(runtime, 'daemon', 'node_modules', '@napi-rs'), { recursive: true });

cpSync(process.execPath, join(runtime, 'node.exe'));
cpSync(bundle, join(runtime, 'daemon', 'worker-daemon.mjs'));
// Bundled with sourcemap: true so crash traces map back to the TS source. ~1.5 MB,
// no secrets, ship it alongside the bundle.
if (existsSync(bundleMap)) {
  cpSync(bundleMap, join(runtime, 'daemon', 'worker-daemon.mjs.map'));
}

// The native keyring cannot be bundled: ship the package and its platform binary so
// `import('@napi-rs/keyring')` resolves from runtime/daemon/node_modules.
const fromWorker = createRequire(join(workerDir, 'package.json'));
const keyringDir = dirname(fromWorker.resolve('@napi-rs/keyring/package.json'));
const fromKeyring = createRequire(join(keyringDir, 'package.json'));
const platformDir = dirname(fromKeyring.resolve('@napi-rs/keyring-win32-x64-msvc/package.json'));
const modules = join(runtime, 'daemon', 'node_modules', '@napi-rs');
cpSync(keyringDir, join(modules, 'keyring'), { recursive: true, dereference: true });
cpSync(platformDir, join(modules, 'keyring-win32-x64-msvc'), {
  recursive: true,
  dereference: true,
});

console.log(`Staged Node ${process.version}, worker daemon and keyring into ${runtime}`);
