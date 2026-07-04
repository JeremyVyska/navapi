import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node20',
  // Optional native dep: resolved at runtime when installed, never bundled.
  external: ['@napi-rs/keyring'],
});
