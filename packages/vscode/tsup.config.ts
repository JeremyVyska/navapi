import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/extension.ts'],
  // VS Code extension hosts require CommonJS; @navapi/core (ESM) gets bundled in,
  // so the shipped extension has no runtime dependencies besides the vscode API.
  format: ['cjs'],
  external: ['vscode'],
  sourcemap: true,
  clean: true,
  target: 'node20',
});
