/**
 * Builds platform-specific .vsix packages, one per VS Code target, each
 * bundling only that platform's @napi-rs/keyring native binding (downloaded
 * from npm). The Marketplace serves each user the matching package; on any
 * platform the keyring falls back to the file secret store if absent.
 *
 * Usage: node scripts/package-all.mjs
 * Output: dist/vsix/navapi-vscode-<target>-<version>.vsix
 *
 * Single-platform local builds still use `pnpm run package` (host binding only).
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.join(here, '..');
const require = createRequire(path.join(pkgDir, 'package.json'));
const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));

// VS Code --target → @napi-rs/keyring binding package name.
const TARGETS = {
  'win32-x64': '@napi-rs/keyring-win32-x64-msvc',
  'win32-arm64': '@napi-rs/keyring-win32-arm64-msvc',
  'darwin-x64': '@napi-rs/keyring-darwin-x64',
  'darwin-arm64': '@napi-rs/keyring-darwin-arm64',
  'linux-x64': '@napi-rs/keyring-linux-x64-gnu',
  'linux-arm64': '@napi-rs/keyring-linux-arm64-gnu',
  'alpine-x64': '@napi-rs/keyring-linux-x64-musl',
  'alpine-arm64': '@napi-rs/keyring-linux-arm64-musl',
};

const keyringPkgJson = require.resolve('@napi-rs/keyring/package.json');
const keyringSrc = path.dirname(keyringPkgJson);
const keyringVersion = JSON.parse(readFileSync(keyringPkgJson, 'utf8')).version;
const distNodeModules = path.join(pkgDir, 'dist', 'node_modules');
const vsixOut = path.join(pkgDir, 'dist', 'vsix');
const cacheDir = path.join(os.tmpdir(), 'navapi-keyring-cache', keyringVersion);
const vsceBin = require.resolve('@vscode/vsce/vsce');
const npmCli = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(file, args, opts = {}) {
  return execFileSync(file, args, { stdio: 'inherit', cwd: pkgDir, ...opts });
}

/**
 * Downloads (and caches) one binding package, returns its extracted dir.
 * Uses `npm install --prefix` so npm handles fetch + extraction (portable and
 * tar-free); --force gets past EBADPLATFORM for cross-platform bindings.
 */
function fetchBinding(bindingPkg) {
  const base = bindingPkg.split('/')[1]; // e.g. keyring-darwin-arm64
  const dest = path.join(cacheDir, base);
  try {
    readFileSync(path.join(dest, 'package.json')); // cache hit
    return dest;
  } catch {
    // not cached yet
  }
  const prefix = path.join(cacheDir, `_install_${base}`);
  rmSync(prefix, { recursive: true, force: true });
  mkdirSync(prefix, { recursive: true });
  execFileSync(
    npmCli,
    [
      'install',
      `${bindingPkg}@${keyringVersion}`,
      '--prefix',
      prefix,
      '--no-save',
      '--no-package-lock',
      '--force',
      '--loglevel=error',
    ],
    { cwd: pkgDir, stdio: 'inherit', shell: process.platform === 'win32' },
  );
  cpSync(path.join(prefix, 'node_modules', '@napi-rs', base), dest, { recursive: true });
  return dest;
}

/** Stages the main keyring package + the named bindings into dist/node_modules. */
function stageBindings(bindingPkgs) {
  rmSync(distNodeModules, { recursive: true, force: true });
  const napiDir = path.join(distNodeModules, '@napi-rs');
  mkdirSync(napiDir, { recursive: true });
  cpSync(keyringSrc, path.join(napiDir, 'keyring'), { recursive: true, dereference: true });
  for (const bindingPkg of bindingPkgs) {
    cpSync(fetchBinding(bindingPkg), path.join(napiDir, bindingPkg.split('/')[1]), {
      recursive: true,
      dereference: true,
    });
  }
}

// 1. Build the extension bundle once (identical across targets).
console.log('▶ building extension bundle…');
run(process.execPath, [require.resolve('tsup/dist/cli-default.js')]);

rmSync(vsixOut, { recursive: true, force: true });
mkdirSync(vsixOut, { recursive: true });
const built = [];

if (process.argv.includes('universal')) {
  // 2u. One universal package bundling every binding — installs and works on
  // any OS (the loader picks the right one at runtime). Larger, but a single
  // file that uploads cleanly through the Marketplace web UI.
  console.log('\n▶ universal (all bindings)');
  stageBindings(Object.values(TARGETS));
  const outFile = path.join(vsixOut, `navapi-vscode-${pkg.version}.vsix`);
  run(process.execPath, [
    vsceBin,
    'package',
    '--no-dependencies',
    '--allow-missing-repository',
    '-o',
    outFile,
  ]);
  built.push(outFile);
} else {
  // 2. Package per target — smaller downloads, needs `vsce publish --target`.
  for (const [target, bindingPkg] of Object.entries(TARGETS)) {
    console.log(`\n▶ ${target}  (${bindingPkg})`);
    stageBindings([bindingPkg]);
    const outFile = path.join(vsixOut, `navapi-vscode-${target}-${pkg.version}.vsix`);
    run(process.execPath, [
      vsceBin,
      'package',
      '--target',
      target,
      '--no-dependencies',
      '--allow-missing-repository',
      '-o',
      outFile,
    ]);
    built.push(outFile);
  }
}

console.log(`\n✔ built ${built.length} package(s) in ${vsixOut}:`);
for (const f of readdirSync(vsixOut)) console.log(`  ${f}`);
