/**
 * Standalone stdio entry for the navapi MCP server, bundled into the vsix as
 * dist/mcp-server.mjs and launched by VS Code's MCP provider (see extension.ts)
 * so GitHub Copilot agent mode can call navapi's tools. Reuses @navapi/mcp
 * verbatim; the active profile + config dir arrive via env from the provider.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createNavapiServer } from '@navapi/mcp';

const server = createNavapiServer();
const transport = new StdioServerTransport();

server.connect(transport).catch((err: unknown) => {
  console.error(`navapi-mcp failed to start: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
