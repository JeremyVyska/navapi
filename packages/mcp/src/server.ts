import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  type BatchRequest,
  type BcClient,
  BraiderClient,
  type BraiderEndpointSpec,
  type BraiderFilter,
  type BraiderWriteAction,
  type BraiderWriteRecord,
  type CachedRouteMetadata,
  type ClientSelector,
  companyLabel,
  createClientForSelector,
  defaultConfigDir,
  detectBraider,
  findCompany,
  ProfileStore,
  searchEntitySets,
} from '@navapi/core';
import { z } from 'zod';

export interface NavapiServerOptions {
  /** Injectable for tests; defaults to profile-based construction from disk config. */
  clientFactory?: (selector: ClientSelector) => Promise<BcClient>;
  profileStore?: ProfileStore;
}

/**
 * How a tool call says where to run. A profile names a saved credential +
 * tenant + environment; each of those can also be given directly, layered over
 * the profile, so an agent can reach an environment nobody saved a profile for.
 */
const profileArg = {
  profile: z
    .string()
    .optional()
    .describe(
      'Profile name; omit for the default profile. A profile is a saved credential + tenant + environment.',
    ),
  credential: z
    .string()
    .optional()
    .describe(
      'Credential to authenticate with, overriding the profile. Combine with tenant/environment to reach an environment no profile is saved for.',
    ),
  tenant: z.string().optional().describe('Tenant to target, overriding the profile'),
  environment: z.string().optional().describe('Environment to target, overriding the profile'),
};

const scopeArgs = {
  ...profileArg,
  route: z
    .string()
    .optional()
    .describe('Endpoint route, e.g. "v2.0" (default), "publisher/group/v1.0", or "ODataV4"'),
  company: z
    .string()
    .optional()
    .describe('Company name, displayName, or GUID; omit to use the profile default'),
};

const recordKey = z.union([
  z.string(),
  z
    .record(z.union([z.string(), z.number(), z.boolean()]))
    .refine((key) => Object.keys(key).length > 0, 'Record key objects cannot be empty')
    .refine(
      (key) => Object.keys(key).every((name) => name.trim().length > 0),
      'Record key field names cannot be empty',
    ),
]);

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
  const store = options.profileStore ?? new ProfileStore(defaultConfigDir());
  const factory = options.clientFactory ?? ((sel: ClientSelector) => createClientForSelector(sel));

  function getClient(selector: ClientSelector = {}): Promise<BcClient> {
    // The overrides are part of a client's identity, so two calls naming
    // different tenants must not share one cached client.
    const key = [
      selector.profile ?? '',
      selector.credential ?? '',
      selector.tenant ?? '',
      selector.environment ?? '',
    ].join('\u0000');
    let client = clients.get(key);
    if (!client) {
      client = factory(selector);
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
        'List configured navapi profiles and credentials. A profile is a saved credential + tenant + environment; several profiles can share one credential. A profile marked readOnly refuses every write — do not attempt create, update, delete, or actions against it. To reach an environment with no saved profile, pass credential + tenant + environment to any tool.',
      inputSchema: {},
    },
    safe(async () => {
      const { profiles, credentials, defaultProfile } = await store.listAll();
      return {
        defaultProfile,
        credentials: credentials.map(({ name, type }) => ({ name, type })),
        profiles: profiles.map(
          ({ name, tenantId, environment, company, credential, readOnly }) => ({
            name,
            tenantId,
            environment,
            company,
            credential,
            readOnly: Boolean(readOnly),
          }),
        ),
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
    safe(async ({ profile, company, ...sel }) => {
      const client = await getClient({ profile, ...sel });
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
      const label = companyLabel(match);
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
        'List every endpoint group the BC environment exposes: API routes plus ODataV4 when published web services are available.',
      inputSchema: profileArg,
    },
    safe(async ({ profile, ...sel }) => (await getClient({ profile, ...sel })).listRoutes()),
  );

  server.registerTool(
    'list_entities',
    {
      description:
        'The collection tree: entity sets available per API route and published ODataV4 web service, from cached $metadata (auto-discovers on first use). An environment can expose hundreds of entity sets, so pass search to narrow it. Set refresh=true after publishing new endpoints.',
      inputSchema: {
        ...profileArg,
        route: z.string().optional().describe('Limit to one route path'),
        search: z
          .string()
          .optional()
          .describe(
            'Case-insensitive substring matched against the entity set name and entity type, e.g. "customer". Routes with no match are left out.',
          ),
        refresh: z.boolean().optional().describe('Refetch $metadata from the environment'),
      },
    },
    safe(async ({ profile, route, search, refresh, ...sel }) => {
      const client = await getClient({ profile, ...sel });
      const { cached, errors } = await ensureMetadata(client, refresh);
      const scoped = route ? cached.filter((c) => c.routePath === route) : cached;
      const routes = scoped
        .map((c) => ({
          route: c.routePath,
          fetchedAt: c.fetchedAt,
          entitySets: searchEntitySets([c], search).map(({ entitySet: s }) => ({
            name: s.name,
            entityType: s.entityType,
            keys: s.keys,
            actions: s.actions,
          })),
        }))
        .filter((r) => !search || r.entitySets.length);
      return { routes, errors };
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
    safe(async ({ profile, entitySet, route, ...sel }) => {
      const client = await getClient({ profile, ...sel });
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
    // The selector fields are named explicitly here: `rest` becomes the OData
    // query, and credential/tenant/environment must not leak into it.
    safe(
      async ({
        profile,
        credential,
        tenant,
        environment,
        entitySet,
        route,
        company,
        all,
        includeCount,
        pageSize,
        ...rest
      }) => {
        const client = await getClient({ profile, credential, tenant, environment });
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
      },
    ),
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
    safe(async ({ profile, nextLink, ...sel }) => {
      const page = await (await getClient({ profile, ...sel })).followNextLink(nextLink);
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
        id: recordKey.describe('Scalar record key or named key object for composite OData keys'),
        navProperty: z.string().describe('Navigation property name, e.g. "salesOrderLines"'),
      },
    },
    safe(async ({ profile, entitySet, id, navProperty, route, company, ...sel }) =>
      (await getClient({ profile, ...sel })).getNavigation(entitySet, id, navProperty, {
        route,
        company,
      }),
    ),
  );

  server.registerTool(
    'get_record',
    {
      description: 'Fetch a single record by its key (GUID keys bare, string keys as-is).',
      inputSchema: {
        ...scopeArgs,
        entitySet: z.string(),
        id: recordKey.describe('Scalar record key or named key object for composite OData keys'),
      },
    },
    safe(async ({ profile, entitySet, id, route, company, ...sel }) =>
      (await getClient({ profile, ...sel })).getRecord(entitySet, id, { route, company }),
    ),
  );

  server.registerTool(
    'create_record',
    {
      description:
        'Create a record in an API entity set or writable published ODataV4 page. Query services and non-editable pages reject writes.',
      inputSchema: {
        ...scopeArgs,
        entitySet: z.string(),
        record: z.record(z.unknown()).describe('Field values for the new record'),
      },
    },
    safe(async ({ profile, entitySet, record, route, company, ...sel }) =>
      (await getClient({ profile, ...sel })).create(entitySet, record, { route, company }),
    ),
  );

  server.registerTool(
    'update_record',
    {
      description:
        'Update fields on an API or writable published ODataV4 record. Accepts named composite keys. Concurrency-safe: fetches the current ETag, sends If-Match, and retries once on conflict.',
      inputSchema: {
        ...scopeArgs,
        entitySet: z.string(),
        id: recordKey.describe('Scalar record key or named key object for composite OData keys'),
        patch: z.record(z.unknown()).describe('Fields to change'),
      },
    },
    safe(async ({ profile, entitySet, id, patch, route, company, ...sel }) =>
      (await getClient({ profile, ...sel })).update(entitySet, id, patch, { route, company }),
    ),
  );

  server.registerTool(
    'delete_record',
    {
      description:
        'Delete an API or writable published ODataV4 record. Accepts named composite keys; ETags are handled automatically.',
      inputSchema: {
        ...scopeArgs,
        entitySet: z.string(),
        id: recordKey.describe('Scalar record key or named key object for composite OData keys'),
      },
    },
    safe(async ({ profile, entitySet, id, route, company, ...sel }) => {
      await (await getClient({ profile, ...sel })).deleteRecord(entitySet, id, { route, company });
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
    safe(async ({ profile, entitySet, id, action, parameters, route, company, ...sel }) => {
      const result = await (await getClient({ profile, ...sel })).callAction(
        entitySet,
        id,
        action,
        {
          route,
          company,
          parameters,
        },
      );
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
    safe(async ({ profile, requests, route, company, ...sel }) =>
      (await getClient({ profile, ...sel })).batch(requests as BatchRequest[], { route, company }),
    ),
  );

  // ------------------------------------------------------------ Data Braider

  const braiderClients = new Map<string, Promise<BraiderClient>>();

  function getBraider(selector: ClientSelector = {}): Promise<BraiderClient> {
    const key = [
      selector.profile ?? '',
      selector.credential ?? '',
      selector.tenant ?? '',
      selector.environment ?? '',
    ].join(' ');
    let braider = braiderClients.get(key);
    if (!braider) {
      braider = (async () => {
        const client = await getClient(selector);
        const info = await detectBraider(client);
        if (!info) {
          throw new Error(
            'Data Braider was not detected in this environment. ' +
              'Use braider_status with refresh=true to re-check, or verify the extension is installed.',
          );
        }
        return new BraiderClient(client, info);
      })();
      braiderClients.set(key, braider);
      braider.catch(() => braiderClients.delete(key));
    }
    return braider;
  }

  const braiderFilterSchema = z
    .array(
      z.object({
        table: z.union([z.string(), z.number()]).describe('Table name or number'),
        field: z.union([z.string(), z.number()]).describe('Field name or number'),
        filter: z.string().describe('BC filter expression, e.g. "10000..20000" or "<>\'\'"'),
      }),
    )
    .optional()
    .describe('Data Braider filters (BC filter syntax, NOT OData $filter)');

  server.registerTool(
    'braider_status',
    {
      description:
        'Detect Data Braider (the no-code BC API factory) in the environment: route path, version, and capability level (read/write only vs. full config/authoring API on Braider 2.4+).',
      inputSchema: {
        ...profileArg,
        refresh: z.boolean().optional().describe('Re-enumerate routes and refetch metadata'),
      },
    },
    safe(async ({ profile, refresh, ...sel }) => {
      const client = await getClient({ profile, ...sel });
      const info = await detectBraider(client, { refresh });
      if (refresh) braiderClients.clear();
      return info ? { installed: true, ...info } : { installed: false };
    }),
  );

  server.registerTool(
    'braider_list_endpoints',
    {
      description:
        'List configured Data Braider endpoints: code, description, endpoint type (Read Only | Per Record | Batch | Delta Read), and output format (Flat | Hierarchy).',
      inputSchema: {
        ...profileArg,
        company: z.string().optional().describe('Company override for this call'),
      },
    },
    safe(async ({ profile, company, ...sel }) =>
      (await getBraider({ profile, ...sel })).listEndpoints({ company }),
    ),
  );

  server.registerTool(
    'braider_read',
    {
      description:
        'Read data from a Data Braider endpoint. The double-encoded jsonResult payload is unwrapped — records come back as plain JSON. Flat endpoints return objects keyed "TableName.FieldName"; Hierarchy endpoints return nested {data, children} nodes. Paging is 1-based by page index.',
      inputSchema: {
        ...profileArg,
        company: z.string().optional().describe('Company override for this call'),
        code: z.string().describe('Endpoint code, e.g. "CUSTOMERS"'),
        filters: braiderFilterSchema,
        pageStart: z.number().int().positive().optional().describe('1-based page index'),
        pageSize: z.number().int().positive().optional().describe('Top-level records per page'),
        all: z.boolean().optional().describe('Fetch every page (bounded by the record count)'),
        includeDiagnostics: z
          .boolean()
          .optional()
          .describe('Include the diagnostics envelope when the endpoint emits one'),
      },
    },
    safe(
      async ({
        profile,
        company,
        code,
        filters,
        pageStart,
        pageSize,
        all,
        includeDiagnostics,
        ...sel
      }) => {
        const braider = await getBraider({ profile, ...sel });
        const result = await braider.readEndpoint(code, {
          company,
          filters: filters as BraiderFilter[] | undefined,
          pageStart,
          pageSize,
          all,
        });
        return {
          records: result.records,
          hasMore: result.hasMore,
          pageStart: result.pageStart,
          pageSize: result.pageSize,
          topLevelRecordCount: result.topLevelRecordCount,
          ...(includeDiagnostics ? { diagnostics: result.diagnostics ?? null } : {}),
        };
      },
    ),
  );

  server.registerTool(
    'braider_write',
    {
      description:
        'Submit records to a Data Braider write endpoint. Each record uses "TableName.FieldName" keys (see braider_get_schema for the exact names) plus an "Action": Insert | Update | Delete | Upsert; defaultAction fills records that omit it. Returns one result per record ({action, data} or {action: "delete", gravestonePK}).',
      inputSchema: {
        ...profileArg,
        company: z.string().optional().describe('Company override for this call'),
        code: z.string().describe('Write endpoint code'),
        records: z
          .array(z.record(z.unknown()))
          .min(1)
          .describe('Records with "Table.Field" keys and optional "Action"'),
        defaultAction: z
          .enum(['Insert', 'Update', 'Delete', 'Upsert'])
          .optional()
          .describe('Action applied to records without their own'),
      },
    },
    safe(async ({ profile, company, code, records, defaultAction, ...sel }) =>
      (await getBraider({ profile, ...sel })).writeEndpoint(code, records as BraiderWriteRecord[], {
        company,
        defaultAction: defaultAction as BraiderWriteAction | undefined,
      }),
    ),
  );

  server.registerTool(
    'braider_get_schema',
    {
      description:
        'Per-endpoint field schema: the exact "TableName.FieldName" property names with types, required flags, and (on Braider 2.4+) field/table numbers and write-enabled markers. source="api" is exact; source="inferred" is sampled from data.',
      inputSchema: {
        ...profileArg,
        company: z.string().optional().describe('Company override for this call'),
        code: z.string().describe('Endpoint code'),
      },
    },
    safe(async ({ profile, company, code, ...sel }) =>
      (await getBraider({ profile, ...sel })).getEndpointSchema(code, { company }),
    ),
  );

  server.registerTool(
    'braider_list_tables',
    {
      description:
        'Tables available for Data Braider endpoint authoring (requires Braider 2.4+). Use before braider_create_endpoint to resolve table numbers/names.',
      inputSchema: {
        ...profileArg,
        company: z.string().optional().describe('Company override for this call'),
        search: z.string().optional().describe('Substring to match in table name or caption'),
      },
    },
    safe(async ({ profile, company, search, ...sel }) =>
      (await getBraider({ profile, ...sel })).listAvailableTables({ company, search }),
    ),
  );

  server.registerTool(
    'braider_list_fields',
    {
      description:
        'Fields of one table (numbers, names, types, PK markers) for Data Braider endpoint authoring (requires Braider 2.4+).',
      inputSchema: {
        ...profileArg,
        company: z.string().optional().describe('Company override for this call'),
        tableNo: z.number().int().describe('Table number, e.g. 18 for Customer'),
      },
    },
    safe(async ({ profile, company, tableNo, ...sel }) =>
      (await getBraider({ profile, ...sel })).listAvailableFields(tableNo, { company }),
    ),
  );

  server.registerTool(
    'braider_create_endpoint',
    {
      description:
        'Create a complete Data Braider endpoint remotely (requires Braider 2.4+): config header, source-table lines (fields auto-populate), and enabled fields. sourceTable accepts a table number or name; includeFields entries are field names/numbers or {field, writeEnabled, mandatory, filter, defaultValue, upsertMatch, manualFieldCaption} objects.',
      inputSchema: {
        ...profileArg,
        company: z.string().optional().describe('Company override for this call'),
        spec: z
          .object({
            code: z.string().max(20),
            description: z.string().optional(),
            endpointType: z.enum(['Read Only', 'Per Record', 'Batch']),
            outputJsonType: z.enum(['Hierarchy', 'Flat']).optional(),
            enabled: z.boolean().optional(),
            hideFromLists: z.boolean().optional(),
            pageSize: z.number().int().positive().optional(),
            lines: z
              .array(
                z.object({
                  sourceTable: z.union([z.number().int(), z.string()]),
                  indentation: z.number().int().nonnegative().optional(),
                  includeFields: z
                    .array(
                      z.union([
                        z.string(),
                        z.number().int(),
                        z.object({
                          field: z.union([z.string(), z.number().int()]),
                          writeEnabled: z.boolean().optional(),
                          mandatory: z.boolean().optional(),
                          filter: z.string().optional(),
                          defaultValue: z.string().optional(),
                          upsertMatch: z.boolean().optional(),
                          manualFieldCaption: z.string().optional(),
                        }),
                      ]),
                    )
                    .min(1),
                }),
              )
              .min(1),
          })
          .describe('Endpoint specification'),
      },
    },
    safe(async ({ profile, company, spec, ...sel }) =>
      (await getBraider({ profile, ...sel })).createEndpoint(spec as BraiderEndpointSpec, {
        company,
      }),
    ),
  );

  server.registerTool(
    'braider_update_endpoint',
    {
      description:
        'Update a Data Braider endpoint config header by code (requires Braider 2.4+). Enum fields accept plain names, e.g. endpointType "Per Record".',
      inputSchema: {
        ...profileArg,
        company: z.string().optional().describe('Company override for this call'),
        code: z.string().describe('Endpoint code'),
        patch: z
          .record(z.unknown())
          .describe('Config header fields to change, e.g. {"enabled": true}'),
      },
    },
    safe(async ({ profile, company, code, patch, ...sel }) =>
      (await getBraider({ profile, ...sel })).updateEndpoint(
        code,
        patch as Record<string, unknown>,
        {
          company,
        },
      ),
    ),
  );

  server.registerTool(
    'braider_delete_endpoint',
    {
      description:
        'Delete a Data Braider endpoint config and all its lines/fields/relations (requires Braider 2.4+). Irreversible.',
      inputSchema: {
        ...profileArg,
        company: z.string().optional().describe('Company override for this call'),
        code: z.string().describe('Endpoint code'),
      },
    },
    safe(async ({ profile, company, code, ...sel }) => {
      await (await getBraider({ profile, ...sel })).deleteEndpoint(code, { company });
      return { deleted: true, code };
    }),
  );

  return server;
}
