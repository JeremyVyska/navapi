/**
 * Copies @napi-rs/keyring (and this platform's native binding package) into
 * dist/node_modules so the bundled CJS extension can require it at runtime.
 * The keyring is optional — if it isn't installed, the extension falls back
 * to the file secret store, so this script never fails the build.
 */
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, '..', 'dist', 'node_modules');

function copyPackage(requireFrom, name) {
  const pkgJson = createRequire(requireFrom).resolve(`${name}/package.json`);
  const src = path.dirname(pkgJson);
  const dest = path.join(target, ...name.split('/'));
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true, dereference: true });
  return pkgJson;
}

rmSync(target, { recursive: true, force: true });
try {
  const keyringPkgJson = copyPackage(path.join(here, '..', 'package.json'), '@napi-rs/keyring');
  const pkg = JSON.parse(readFileSync(keyringPkgJson, 'utf8'));
  let binaries = 0;
  for (const dep of Object.keys(pkg.optionalDependencies ?? {})) {
    try {
      // Platform bindings are deps OF keyring — resolve from its own location.
      copyPackage(keyringPkgJson, dep);
      binaries++;
    } catch {
      // other platforms' bindings aren't installed here — expected
    }
  }
  console.log(`copy-keyring: bundled @napi-rs/keyring with ${binaries} platform binding(s).`);
} catch {
  console.log('copy-keyring: @napi-rs/keyring not installed — extension will use the file store.');
}
