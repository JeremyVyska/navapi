import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  type BatchRequest,
  type BcClient,
  type CachedRouteMetadata,
  createClientForProfile,
  defaultConfigDir,
  findCompany,
  ProfileStore,
} from '@navapi/core';
import { z } from 'zod';

export interface NavapiServerOptions {
  /** Injectable for tests; defaults to profile-based construction from disk config. */
  clientFactory?: (profileName?: string) => Promise<BcClient>;
  profileStore?: ProfileStore;
}

const profileArg = {
  profile: z
    .string()
    .optional()
    .describe('Profile name; omit for the default profile (one profile = one BC environment)'),
};

const scopeArgs = {
  ...profileArg,
  route: z
    .string()
    .optional()
    .describe('API route path, e.g. "v2.0" (default) or "publisher/group/v1.0"'),
  company: z
    .string()
    .optional()
    .describe('Company name, displayName, or GUID; omit to use the profile default'),
};

function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
}

type ToolResult = ReturnType<typeof jsonResult> | ReturnType<typeof errorResult>;

/** Wraps a handler so BC/auth failures surface as tool errors, not protocol faults. */
function safe<A>(fn: (args: A) => Promise<unknown>): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      return jsonResult(await fn(args));
    } catch (err) {
      return errorResult(err);
    }
  };
}

async function ensureMetadata(
  client: BcClient,
  refresh?: boolean,
): Promise<{
  cached: CachedRouteMetadata[];
  errors: { route: string; error: string }[];
}> {
  if (!refresh) {
    const cached = await client.cachedMetadata();
    if (cached.length) return { cached, errors: [] };
  }
  const results = await client.discoverAll({ refresh });
  return {
    cached: results.filter((r) => r.metadata).map((r) => r.metadata as CachedRouteMetadata),
    errors: results
      .filter((r) => r.error)
      .map((r) => ({ route: r.route.path, error: r.error as string })),
  };
}

/**
 * Builds the navapi MCP server: typed Business Central tools over the same
 * @navapi/core brain the CLI uses. One tool call ≈ one CLI command.
 */
export function createNavapiServer(options: NavapiServerOptions = {}): McpServer {
  const clients = new Map<string, Promise<BcClient>>();
  const factory = options.clientFactory ?? ((name?: string) => createClientForProfile(name));
  const store = options.profileStore ?? new ProfileStore(defaultConfigDir());

  function getClient(profileName?: string): Promise<BcClient> {
    const key = profileName ?? '';
    let client = clients.get(key);
    if (!client) {
      client = factory(profileName);
      clients.set(key, client);
      // Don't cache failed constructions (bad secret, missing profile).
      client.catch(() => clients.delete(key));
    }
    return client;
  }

  const { version } = createRequire(import.meta.url)('../package.json') as { version: string };
  const server = new McpServer({ name: 'navapi', version });

  server.registerTool(
    'list_profiles',
    {
      description:
        'List configured navapi profiles. Each profile pins one Business Central environment (tenant + environment + default company).',
      inputSchema: {},
    },
    safe(async () => {
      const { profiles, defaultProfile } = await store.listAll();
      return {
        defaultProfile,
        profiles: profiles.map(({ name, tenantId, environment, company }) => ({
          name,
          tenantId,
          environment,
          company,
        })),
      };
    }),
  );

  server.registerTool(
    'set_default_company',
    {
      description:
        "Change the profile's default company (validated against the environment's company list). Subsequent tool calls without an explicit company use it.",
      inputSchema: {
        ...profileArg,
        company: z.string().describe('Company name, displayName, or GUID'),
      },
    },
    safe(async ({ profile, company }) => {
      const client = await getClient(profile);
      const companies = await client.listCompanies();
      const match = findCompany(companies, company);
      if (!match) {
        throw new Error(
          `Company "${company}" not found. Available: ${companies
            .map((c) => c.displayName ?? c.name)
            .join(', ')}`,
        );
      }
      const stored = await store.get(profile);
      const label = String(match.displayName ?? match.name ?? match.id);
      await store.upsert({ ...stored, company: label });
      // Cached clients hold the old profile snapshot; rebuild on next use.
      clients.clear();
      return { profile: stored.name, company: label, companyId: match.id };
    }),
  );

  server.registerTool(
    'list_routes',
    {
      description:
        'List every API route the BC environment exposes (standard v2.0, Microsoft routes, and custom publisher/group/version APIs).',
      inputSchema: profileArg,
    },
    safe(async ({ profile }) => (await getClient(profile)).listRoutes()),
  );

  server.registerTool(
    'list_entities',
    {
      description:
        'The collection tree: entity sets available per API route, from cached $metadata (auto-discovers on first use). Set refresh=true after publishing new APIs.',
      inputSchema: {
        ...profileArg,
        route: z.string().optional().describe('Limit to one route path'),
        refresh: z.boolean().optional().describe('Refetch $metadata from the environment'),
      },
    },
    safe(async ({ profile, route, refresh }) => {
      const client = await getClient(profile);
      const { cached, errors } = await ensureMetadata(client, refresh);
      const scoped = route ? cached.filter((c) => c.routePath === route) : cached;
      return {
        routes: scoped.map((c) => ({
          route: c.routePath,
          fetchedAt: c.fetchedAt,
          entitySets: c.metadata.entitySets.map((s) => ({
            name: s.name,
            keys: s.keys,
            actions: s.actions,
          })),
        })),
        errors,
      };
    }),
  );

  server.registerTool(
    'get_entity_schema',
    {
      description:
        'Full schema for an entity set: properties with types/nullability/maxLength, keys, navigation properties, and bound actions.',
      inputSchema: {
        ...profileArg,
        entitySet: z.string().describe('Entity set name, e.g. "customers"'),
        route: z.string().optional().describe('Route to search; omit to search all cached routes'),
      },
    },
    safe(async ({ profile, entitySet, route }) => {
      const client = await getClient(profile);
      const { cached } = await ensureMetadata(client);
      const scoped = route ? cached.filter((c) => c.routePath === route) : cached;
      const matches = scoped.flatMap((c) =>
        c.metadata.entitySets
          .filter((s) => s.name.toLowerCase() === entitySet.toLowerCase())
          .map((s) => ({ route: c.routePath, ...s })),
      );
      if (!matches.length) {
        throw new Error(
          `Entity set "${entitySet}" not found in cached metadata. Try list_entities with refresh=true.`,
        );
      }
      return matches;
    }),
  );

  server.registerTool(
    'get_records',
    {
      description:
        'Query records from an entity set with OData options. Returns items, hasMore, nextLink (feed to get_next_page), the exact queryUrl, and — with includeCount — the total matching count.',
      inputSchema: {
        ...scopeArgs,
        entitySet: z.string().describe('Entity set name, e.g. "customers"'),
        filter: z.string().optional().describe('OData $filter, e.g. "status eq \'Open\'"'),
        select: z.array(z.string()).optional().describe('Fields for $select'),
        expand: z.array(z.string()).optional().describe('Navigation properties for $expand'),
        orderby: z.array(z.string()).optional().describe('$orderby terms, e.g. ["number desc"]'),
        top: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('$top hard cap on total results (does NOT produce a nextLink)'),
        skip: z.number().int().nonnegative().optional().describe('$skip offset'),
        pageSize: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Server-driven page size (Prefer: odata.maxpagesize). Use this for paging — it yields a nextLink when more records exist.',
          ),
        all: z.boolean().optional().describe('Follow @odata.nextLink to fetch every page'),
        includeCount: z
          .boolean()
          .optional()
          .describe('Also request $count=true and return the total matching records'),
      },
    },
    safe(async ({ profile, entitySet, route, company, all, includeCount, pageSize, ...rest }) => {
      const client = await getClient(profile);
      const query = { ...rest, count: includeCount || undefined };
      const opts = { route, company, all, query, maxPageSize: pageSize };
      const [result, queryUrl] = await Promise.all([
        client.list(entitySet, opts),
        client.buildListUrl(entitySet, opts),
      ]);
      return {
        items: result.items,
        hasMore: Boolean(result.nextLink),
        nextLink: result.nextLink,
        count: result.count,
        queryUrl,
      };
    }),
  );

  server.registerTool(
    'get_next_page',
    {
      description:
        'Continue a paged get_records result: pass the nextLink it returned to fetch the following page.',
      inputSchema: {
        ...profileArg,
        nextLink: z.string().describe('The @odata.nextLink from a previous get_records call'),
      },
    },
    safe(async ({ profile, nextLink }) => {
      const page = await (await getClient(profile)).followNextLink(nextLink);
      return { items: page.items, hasMore: Boolean(page.nextLink), nextLink: page.nextLink };
    }),
  );

  server.registerTool(
    'get_navigation',
    {
      description:
        "Fetch a navigation property of one record, e.g. a salesOrder's salesOrderLines or a customer's currency. Use get_entity_schema to see which navigations exist.",
      inputSchema: {
        ...scopeArgs,
        entitySet: z.string(),
        id: z.string().describe('Record key'),
        navProperty: z.string().describe('Navigation property name, e.g. "salesOrderLines"'),
      },
    },
    safe(async ({ profile, entitySet, id, navProperty, route, company }) =>
      (await getClient(profile)).getNavigation(entitySet, id, navProperty, { route, company }),
    ),
  );

  server.registerTool(
    'get_record',
    {
      description: 'Fetch a single record by its key (GUID keys bare, string keys as-is).',
      inputSchema: {
        ...scopeArgs,
        entitySet: z.string(),
        id: z.string().describe('Record key'),
      },
    },
    safe(async ({ profile, entitySet, id, route, company }) =>
      (await getClient(profile)).getRecord(entitySet, id, { route, company }),
    ),
  );

  server.registerTool(
    'create_record',
    {
      description: 'Create a record in an entity set.',
      inputSchema: {
        ...scopeArgs,
        entitySet: z.string(),
        record: z.record(z.unknown()).describe('Field values for the new record'),
      },
    },
    safe(async ({ profile, entitySet, record, route, company }) =>
      (await getClient(profile)).create(entitySet, record, { route, company }),
    ),
  );

  server.registerTool(
    'update_record',
    {
      description:
        'Update fields on a record. Concurrency-safe: fetches the current ETag, sends If-Match, and retries once on conflict.',
      inputSchema: {
        ...scopeArgs,
        entitySet: z.string(),
        id: z.string().describe('Record key'),
        patch: z.record(z.unknown()).describe('Fields to change'),
      },
    },
    safe(async ({ profile, entitySet, id, patch, route, company }) =>
      (await getClient(profile)).update(entitySet, id, patch, { route, company }),
    ),
  );

  server.registerTool(
    'delete_record',
    {
      description: 'Delete a record (ETag handled automatically).',
      inputSchema: {
        ...scopeArgs,
        entitySet: z.string(),
        id: z.string().describe('Record key'),
      },
    },
    safe(async ({ profile, entitySet, id, route, company }) => {
      await (await getClient(profile)).deleteRecord(entitySet, id, { route, company });
      return { deleted: true, entitySet, id };
    }),
  );

  server.registerTool(
    'invoke_action',
    {
      description:
        'Invoke a bound action on a record, e.g. shipAndInvoice on a salesOrder. Bare action names are qualified with the schema namespace (Microsoft.NAV by default). Use get_entity_schema to see available actions.',
      inputSchema: {
        ...scopeArgs,
        entitySet: z.string(),
        id: z.string().describe('Record key'),
        action: z.string().describe('Action name, bare ("shipAndInvoice") or fully qualified'),
        parameters: z.record(z.unknown()).optional().describe('Action parameter object'),
      },
    },
    safe(async ({ profile, entitySet, id, action, parameters, route, company }) => {
      const result = await (await getClient(profile)).callAction(entitySet, id, action, {
        route,
        company,
        parameters,
      });
      return result ?? { ok: true, action, entitySet, id };
    }),
  );

  server.registerTool(
    'invoke_batch',
    {
      description:
        'Run multiple operations in one OData $batch round-trip. Request URLs are relative to the route root and may use the {company} token, e.g. "companies({company})/customers?$top=5". Sub-request failures are reported per response, not thrown.',
      inputSchema: {
        ...scopeArgs,
        requests: z
          .array(
            z.object({
              method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']),
              url: z.string(),
              id: z.string().optional(),
              headers: z.record(z.string()).optional(),
              body: z.unknown().optional(),
              atomicityGroup: z.string().optional(),
              dependsOn: z.array(z.string()).optional(),
            }),
          )
          .min(1),
      },
    },
    safe(async ({ profile, requests, route, company }) =>
      (await getClient(profile)).batch(requests as BatchRequest[], { route, company }),
    ),
  );

  return server;
}
