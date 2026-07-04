# @navapi/core

The shared brain of [navapi](../../README.md): auth, HTTP, ETag handling, `$metadata` discovery, pagination, and retries for Microsoft Dynamics 365 Business Central APIs. Zero UI assumptions — the CLI, VS Code extension, and MCP server are all thin wrappers over this.

```ts
import { BcClient, ClientCredentialsAuth } from '@navapi/core';

const client = new BcClient({
  profile: {
    name: 'contoso-prod',
    tenantId: '...',
    clientId: '...',
    environment: 'Production',
    company: 'CRONUS International Ltd.',
  },
  auth: new ClientCredentialsAuth({ tenantId: '...', clientId: '...', clientSecret: '...' }),
});

// Discovery: enumerate every API route, ingest + cache $metadata per route
const results = await client.discoverAll();

// CRUD with transparent ETags (GET → If-Match → retry-once on 412)
const { items } = await client.list('customers', { query: { filter: "blocked eq ' '" } });
await client.update('customers', items[0].id!, { blocked: 'All' });
```

See the [repo README](../../README.md) for the full story.
