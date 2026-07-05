import { defineConfig } from 'tsup';

export default defineConfig([
  {
    // VS Code extension host requires CommonJS; @navapi/core (ESM) gets bundled in.
    // @napi-rs/keyring stays external (native binding) — scripts/copy-keyring.mjs
    // places it in dist/node_modules so the bundled require resolves at runtime.
    entry: ['src/extension.ts'],
    format: ['cjs'],
    external: ['vscode', '@napi-rs/keyring'],
    sourcemap: true,
    clean: true,
    target: 'node20',
  },
  {
    // Standalone MCP server that VS Code's MCP provider launches for Copilot
    // agent mode. ESM (the SDK and @navapi/mcp are ESM); .mjs so Node treats it
    // as ESM regardless of package type. keyring stays external and resolves
    // from dist/node_modules at runtime, same as the extension bundle.
    entry: ['src/mcp-server.ts'],
    format: ['esm'],
    external: ['@napi-rs/keyring'],
    sourcemap: false,
    clean: false,
    target: 'node20',
    outExtension: () => ({ js: '.mjs' }),
  },
]);
