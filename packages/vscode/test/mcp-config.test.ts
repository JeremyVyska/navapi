import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mcpServerEnv } from '../src/mcp-config.js';

const pkg = JSON.parse(
  readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'),
    'utf8',
  ),
);

describe('mcpServerEnv', () => {
  it('always sets the config dir and runs the editor binary as node', () => {
    const env = mcpServerEnv(undefined, '/home/x/.navapi');
    expect(env.NAVAPI_CONFIG_DIR).toBe('/home/x/.navapi');
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('scopes the server to the active profile when one is set', () => {
    expect(mcpServerEnv('contoso', '/cfg').NAVAPI_PROFILE).toBe('contoso');
  });

  it('omits NAVAPI_PROFILE when no profile is active', () => {
    expect('NAVAPI_PROFILE' in mcpServerEnv(undefined, '/cfg')).toBe(false);
  });
});

describe('MCP contribution manifest', () => {
  it('declares the provider id the extension registers', () => {
    const providers = pkg.contributes?.mcpServerDefinitionProviders;
    expect(Array.isArray(providers)).toBe(true);
    expect(providers.map((p: { id: string }) => p.id)).toContain('navapi.mcp');
  });

  it('requires a VS Code version with the finalized MCP provider API', () => {
    // registerMcpServerDefinitionProvider is finalized in 1.101.
    expect(pkg.engines.vscode).toBe('^1.101.0');
  });

  it('ships the bundled server the provider points at', () => {
    // .vscodeignore must allowlist dist/mcp-server.mjs or the vsix won't carry it.
    const ignore = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.vscodeignore'),
      'utf8',
    );
    expect(ignore).toMatch(/^!dist\/mcp-server\.mjs$/m);
  });
});
