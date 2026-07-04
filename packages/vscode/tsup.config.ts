import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/extension.ts'],
  // VS Code extension hosts require CommonJS; @navapi/core (ESM) gets bundled in.
  // @napi-rs/keyring stays external (native binding) — scripts/copy-keyring.mjs
  // places it in dist/node_modules so the bundled require resolves at runtime.
  format: ['cjs'],
  external: ['vscode', '@napi-rs/keyring'],
  sourcemap: true,
  clean: true,
  target: 'node20',
});
