import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createNavapiServer } from './server.js';

const server = createNavapiServer();
const transport = new StdioServerTransport();

server.connect(transport).catch((err: unknown) => {
  console.error(`navapi-mcp failed to start: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
