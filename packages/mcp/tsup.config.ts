import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    sourcemap: true,
    clean: true,
    target: 'node20',
    banner: { js: '#!/usr/bin/env node' },
  },
  {
    entry: ['src/server.ts'],
    format: ['esm'],
    dts: true,
    sourcemap: true,
    target: 'node20',
  },
]);
