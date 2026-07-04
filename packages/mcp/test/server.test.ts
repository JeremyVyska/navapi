import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  BcClient,
  MetadataCache,
  ProfileStore,
  parseMetadata,
  StaticTokenProvider,
} from '@navapi/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNavapiServer } from '../src/server.js';

const COMPANY_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CUST_ID = '01121212-a0b0-e011-8fb2-78e7d1625bd8';

const EDMX = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Microsoft.NAV" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="customer">
        <Key><PropertyRef Name="id" /></Key>
        <Property Name="id" Type="Edm.Guid" Nullable="false" />
        <Property Name="displayName" Type="Edm.String" MaxLength="100" />
      </EntityType>
      <EntityContainer Name="NAV">
        <EntitySet Name="customers" EntityType="Microsoft.NAV.customer" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

let tmpDir: string;
let recorded: { method: string; url: string; headers: Record<string, string> }[];

/** fetch fake that emulates just enough BC for the MCP tools. */
function fakeFetch(): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    recorded.push({ method, url, headers });

    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (url.endsWith('/api/routes')) return json(200, { value: [{ route: 'v2.0' }] });
    if (url.endsWith('/v2.0/$metadata')) {
      return new Response(EDMX, { status: 200, headers: { 'content-type': 'application/xml' } });
    }
    if (url.endsWith('/v2.0/companies')) {
      return json(200, { value: [{ id: COMPANY_ID, name: 'CRONUS', displayName: 'CRONUS Ltd.' }] });
    }
    if (url.includes(`customers(${CUST_ID})/shipments`)) {
      return json(200, { value: [{ number: 'SH-1' }, { number: 'SH-2' }] });
    }
    if (url.includes(`customers(${CUST_ID})`)) {
      if (method === 'GET') {
        return json(200, { '@odata.etag': 'W/"e1"', id: CUST_ID, displayName: 'Adatum' });
      }
      if (method === 'PATCH') {
        if (headers['if-match'] !== 'W/"e1"') {
          return json(412, { error: { code: 'Conflict', message: 'etag mismatch' } });
        }
        return json(200, { '@odata.etag': 'W/"e2"', id: CUST_ID, displayName: 'Adatum Renamed' });
      }
    }
    if (url.includes('skiptoken=p2')) {
      return json(200, { value: [{ id: 'cust-2', displayName: 'Trey' }] });
    }
    if (url.includes('/customers')) {
      const body: Record<string, unknown> = { value: [{ id: CUST_ID, displayName: 'Adatum' }] };
      if (url.includes('count=true')) body['@odata.count'] = 42;
      if (url.includes('top=1')) {
        body['@odata.nextLink'] = `${url.replace(/\?.*$/, '')}?$skiptoken=p2`;
      }
      return json(200, body);
    }
    if (url.endsWith('/$batch')) {
      return json(200, { responses: [{ id: '1', status: 200, body: { value: [] } }] });
    }
    return json(404, { error: { code: 'NotFound', message: `no handler for ${method} ${url}` } });
  }) as typeof globalThis.fetch;
}

async function connectedClient() {
  const cache = new MetadataCache(path.join(tmpDir, 'cache'));
  const store = new ProfileStore(tmpDir);
  await store.upsert({
    name: 'test',
    tenantId: 'tenant-1',
    clientId: 'c',
    environment: 'Sandbox',
    company: 'CRONUS',
  });
  const server = createNavapiServer({
    profileStore: store,
    clientFactory: async () =>
      new BcClient({
        profile: {
          name: 'test',
          tenantId: 'tenant-1',
          clientId: 'c',
          environment: 'Sandbox',
          company: 'CRONUS',
        },
        auth: new StaticTokenProvider('tok'),
        fetch: fakeFetch(),
        cache,
      }),
  });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function parseText(result: Awaited<ReturnType<Client['callTool']>>): any {
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0].text);
}

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'navapi-mcp-'));
  recorded = [];
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('navapi MCP server', () => {
  it('exposes the full tool set', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'create_record',
      'delete_record',
      'get_entity_schema',
      'get_navigation',
      'get_next_page',
      'get_record',
      'get_records',
      'invoke_action',
      'invoke_batch',
      'list_entities',
      'list_profiles',
      'list_routes',
      'set_default_company',
      'update_record',
    ]);
  });

  it('get_records returns count, queryUrl, and a continuable nextLink', async () => {
    const client = await connectedClient();
    const data = parseText(
      await client.callTool({
        name: 'get_records',
        arguments: { entitySet: 'customers', top: 1, includeCount: true },
      }),
    );
    expect(data.count).toBe(42);
    expect(data.queryUrl).toContain('$top=1');
    expect(data.queryUrl).toContain('$count=true');
    expect(data.hasMore).toBe(true);
    expect(data.nextLink).toContain('skiptoken=p2');

    const page2 = parseText(
      await client.callTool({ name: 'get_next_page', arguments: { nextLink: data.nextLink } }),
    );
    expect(page2.items.map((i: any) => i.displayName)).toEqual(['Trey']);
    expect(page2.hasMore).toBe(false);
  });

  it('get_navigation fetches a record navigation property', async () => {
    const client = await connectedClient();
    const data = parseText(
      await client.callTool({
        name: 'get_navigation',
        arguments: { entitySet: 'customers', id: CUST_ID, navProperty: 'shipments' },
      }),
    );
    expect(data.kind).toBe('collection');
    expect(data.items.map((s: any) => s.number)).toEqual(['SH-1', 'SH-2']);
  });

  it('set_default_company validates and persists the new default', async () => {
    const client = await connectedClient();
    const data = parseText(
      await client.callTool({
        name: 'set_default_company',
        arguments: { company: 'cronus ltd.' }, // case-insensitive displayName match
      }),
    );
    expect(data).toEqual({ profile: 'test', company: 'CRONUS Ltd.', companyId: COMPANY_ID });

    const profiles = parseText(await client.callTool({ name: 'list_profiles', arguments: {} }));
    expect(profiles.profiles[0].company).toBe('CRONUS Ltd.');

    const bad = await client.callTool({
      name: 'set_default_company',
      arguments: { company: 'Nope Inc' },
    });
    expect(bad.isError).toBe(true);
    expect((bad.content as { text: string }[])[0].text).toContain('Available: CRONUS Ltd.');
  });

  it('list_profiles reads the profile store without leaking secrets fields', async () => {
    const client = await connectedClient();
    const data = parseText(await client.callTool({ name: 'list_profiles', arguments: {} }));
    expect(data.defaultProfile).toBe('test');
    expect(data.profiles).toEqual([
      { name: 'test', tenantId: 'tenant-1', environment: 'Sandbox', company: 'CRONUS' },
    ]);
  });

  it('list_entities discovers, caches, and returns the collection tree', async () => {
    const client = await connectedClient();
    const data = parseText(await client.callTool({ name: 'list_entities', arguments: {} }));
    expect(data.routes).toHaveLength(1);
    expect(data.routes[0].route).toBe('v2.0');
    expect(data.routes[0].entitySets).toEqual([{ name: 'customers', keys: ['id'], actions: [] }]);

    // Second call comes from cache: no additional $metadata fetches.
    const metadataFetches = () => recorded.filter((r) => r.url.includes('$metadata')).length;
    const before = metadataFetches();
    await client.callTool({ name: 'list_entities', arguments: {} });
    expect(metadataFetches()).toBe(before);
  });

  it('get_entity_schema returns properties and keys', async () => {
    const client = await connectedClient();
    const data = parseText(
      await client.callTool({ name: 'get_entity_schema', arguments: { entitySet: 'customers' } }),
    );
    expect(data[0].route).toBe('v2.0');
    expect(data[0].keys).toEqual(['id']);
    expect(data[0].properties.map((p: any) => p.name)).toEqual(['id', 'displayName']);
  });

  it('get_records resolves the company and lists items', async () => {
    const client = await connectedClient();
    const data = parseText(
      await client.callTool({ name: 'get_records', arguments: { entitySet: 'customers', top: 5 } }),
    );
    expect(data.items).toHaveLength(1);
    expect(data.hasMore).toBe(false);
    const listCall = recorded.find((r) => r.url.includes('/customers?'));
    expect(listCall?.url).toContain(`companies(${COMPANY_ID})/customers`);
    expect(listCall?.url).toContain('$top=5');
  });

  it('update_record does the transparent ETag dance', async () => {
    const client = await connectedClient();
    const data = parseText(
      await client.callTool({
        name: 'update_record',
        arguments: {
          entitySet: 'customers',
          id: CUST_ID,
          patch: { displayName: 'Adatum Renamed' },
        },
      }),
    );
    expect(data.displayName).toBe('Adatum Renamed');
    const patch = recorded.find((r) => r.method === 'PATCH');
    expect(patch?.headers['if-match']).toBe('W/"e1"');
  });

  it('invoke_batch passes requests through', async () => {
    const client = await connectedClient();
    const data = parseText(
      await client.callTool({
        name: 'invoke_batch',
        arguments: { requests: [{ method: 'GET', url: 'companies({company})/customers' }] },
      }),
    );
    expect(data).toEqual([{ id: '1', status: 200, ok: true, body: { value: [] } }]);
  });

  it('surfaces BC errors as tool errors, not protocol faults', async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: 'get_record',
      arguments: { entitySet: 'unknownThings', id: 'nope' },
    });
    expect(result.isError).toBe(true);
    const content = result.content as { text: string }[];
    expect(content[0].text).toMatch(/^Error: /);
  });

  it('sanity: fixture EDMX parses', () => {
    expect(parseMetadata(EDMX).entitySets).toHaveLength(1);
  });
});
