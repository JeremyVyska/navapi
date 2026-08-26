import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BcClient,
  MetadataCache,
  ODATA_V4_ROUTE,
  PreconditionFailedError,
  StaticTokenProvider,
} from '../src/index.js';
import { SAMPLE_EDMX } from './fixtures/edmx.js';
import { type MockRoute, mockFetch } from './helpers.js';

const COMPANY_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CUSTOMER_ID = '01121212-a0b0-e011-8fb2-78e7d1625bd8';
const API = 'https://api.businesscentral.dynamics.com/v2.0/tenant-1/Sandbox/api';
const ODATA = 'https://api.businesscentral.dynamics.com/v2.0/tenant-1/Sandbox/ODataV4';
const ODATA_UNAVAILABLE: MockRoute = {
  match: (url) => url === `${ODATA}/`,
  status: 404,
  body: { error: { code: 'NotFound', message: 'ODataV4 unavailable' } },
};

const COMPANIES_ROUTE: MockRoute = {
  method: 'GET',
  match: (u) => u.endsWith('/v2.0/companies'),
  body: {
    value: [
      { id: COMPANY_ID, name: 'CRONUS', displayName: 'CRONUS International Ltd.' },
      { id: 'ffffffff-0000-0000-0000-000000000001', name: 'Other', displayName: 'Other Co' },
    ],
  },
};

let tmpDir: string;

function makeClient(routes: MockRoute[], company = 'CRONUS International Ltd.') {
  const { fetchImpl, calls } = mockFetch(routes);
  const client = new BcClient({
    profile: {
      name: 'test',
      tenantId: 'tenant-1',
      clientId: 'c',
      environment: 'Sandbox',
      company,
    },
    auth: new StaticTokenProvider('tok'),
    fetch: fetchImpl,
    cache: new MetadataCache(tmpDir),
    sleep: () => Promise.resolve(),
  });
  return { client, calls };
}

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'navapi-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('BcClient routes & discovery', () => {
  it('adds ODataV4 when published services are available', async () => {
    const { client } = makeClient([
      COMPANIES_ROUTE,
      {
        match: `${API}/microsoft/runtime/beta/companies(${COMPANY_ID})/apiRoutes`,
        body: { value: [{ route: 'v2.0' }] },
      },
      {
        match: (url) => url === `${ODATA}/`,
        body: { value: [{ name: 'customers', kind: 'EntitySet', url: 'customers' }] },
      },
    ]);

    expect((await client.listRoutes()).map((route) => route.path)).toEqual([
      'v2.0',
      ODATA_V4_ROUTE,
    ]);
  });

  it('omits ODataV4 when no published services are visible', async () => {
    const { client } = makeClient([
      COMPANIES_ROUTE,
      {
        match: `${API}/microsoft/runtime/beta/companies(${COMPANY_ID})/apiRoutes`,
        body: { value: [{ route: 'v2.0' }] },
      },
      { match: (url) => url === `${ODATA}/`, body: { value: [] } },
    ]);

    expect((await client.listRoutes()).map((route) => route.path)).toEqual(['v2.0']);
  });

  it.each([403, 404])('omits ODataV4 when its service document returns HTTP %i', async (status) => {
    const { client } = makeClient([
      COMPANIES_ROUTE,
      {
        match: `${API}/microsoft/runtime/beta/companies(${COMPANY_ID})/apiRoutes`,
        body: { value: [{ route: 'v2.0' }] },
      },
      {
        match: (url) => url === `${ODATA}/`,
        status,
        body: { error: { code: 'Unavailable', message: 'ODataV4 unavailable' } },
      },
    ]);

    expect((await client.listRoutes()).map((route) => route.path)).toEqual(['v2.0']);
  });

  it('surfaces unexpected ODataV4 discovery failures', async () => {
    const { client } = makeClient([
      COMPANIES_ROUTE,
      {
        match: `${API}/microsoft/runtime/beta/companies(${COMPANY_ID})/apiRoutes`,
        body: { value: [{ route: 'v2.0' }] },
      },
      {
        match: (url) => url === `${ODATA}/`,
        status: 500,
        body: { error: { code: 'InternalError', message: 'ODataV4 failed' } },
      },
    ]);

    await expect(client.listRoutes()).rejects.toThrow('ODataV4 failed');
  });

  it('combines the ODataV4 service document with its shared metadata', async () => {
    const { client } = makeClient([
      {
        match: (url) => url === `${ODATA}/`,
        body: {
          value: [
            { name: 'customers', kind: 'EntitySet', url: 'customers' },
            { name: 'salesOrders', kind: 'EntitySet', url: 'salesOrders' },
          ],
        },
      },
      { match: `${ODATA}/$metadata`, body: SAMPLE_EDMX },
    ]);

    const cached = await client.getMetadata(ODATA_V4_ROUTE);
    expect(cached.routePath).toBe(ODATA_V4_ROUTE);
    expect(cached.metadata.entitySets.map((entitySet) => entitySet.name)).toEqual([
      'customers',
      'salesOrders',
    ]);
  });

  it('prefers the runtime apiRoutes endpoint (company-scoped)', async () => {
    const { client, calls } = makeClient([
      COMPANIES_ROUTE,
      ODATA_UNAVAILABLE,
      {
        match: `${API}/microsoft/runtime/beta/companies(${COMPANY_ID})/apiRoutes`,
        body: { value: [{ route: 'v2.0' }, { route: 'contoso/fieldops/v1.0' }] },
      },
    ]);
    const routes = await client.listRoutes();
    expect(routes.map((r) => r.path)).toEqual(['v2.0', 'contoso/fieldops/v1.0']);
    expect(calls.some((c) => c.url.endsWith('/api/routes'))).toBe(false);
  });

  it('tries runtime v1.0 when beta is missing', async () => {
    const { client } = makeClient([
      COMPANIES_ROUTE,
      ODATA_UNAVAILABLE,
      {
        match: '/microsoft/runtime/beta/',
        status: 404,
        body: { error: { code: 'NotFound', message: 'x' } },
      },
      {
        match: `${API}/microsoft/runtime/v1.0/companies(${COMPANY_ID})/apiRoutes`,
        body: { value: [{ route: 'v2.0' }] },
      },
    ]);
    const routes = await client.listRoutes();
    expect(routes.map((r) => r.path)).toEqual(['v2.0']);
  });

  it('falls back to /api/routes when the runtime API is unavailable', async () => {
    const { client } = makeClient([
      COMPANIES_ROUTE,
      ODATA_UNAVAILABLE,
      {
        match: '/apiRoutes',
        status: 404,
        body: { error: { code: 'NotFound', message: 'x' } },
      },
      {
        match: `${API}/routes`,
        body: { value: [{ route: 'v2.0' }, { route: 'contoso/fieldops/v1.0' }] },
      },
    ]);
    const routes = await client.listRoutes();
    expect(routes.map((r) => r.path)).toEqual(['v2.0', 'contoso/fieldops/v1.0']);
  });

  it('falls back to the standard route when every source is missing', async () => {
    const { client } = makeClient([
      COMPANIES_ROUTE,
      ODATA_UNAVAILABLE,
      { match: '/apiRoutes', status: 404, body: { error: { code: 'NotFound', message: 'x' } } },
      { match: `${API}/routes`, status: 404, body: { error: { code: 'NotFound', message: 'x' } } },
    ]);
    const routes = await client.listRoutes();
    expect(routes).toEqual([{ path: 'v2.0', version: 'v2.0' }]);
  });

  it('discovers all routes, caches metadata, and reports per-route failures', async () => {
    const { client, calls } = makeClient([
      ODATA_UNAVAILABLE,
      {
        match: `${API}/routes`,
        body: { value: [{ route: 'v2.0' }, { route: 'broken/route/v1.0' }] },
      },
      { match: `${API}/v2.0/$metadata`, body: SAMPLE_EDMX },
      {
        match: `${API}/broken/route/v1.0/$metadata`,
        status: 500,
        body: { error: { code: 'Boom', message: 'metadata exploded' } },
      },
    ]);

    const results = await client.discoverAll();
    expect(results).toHaveLength(2);
    const ok = results.find((r) => r.route.path === 'v2.0');
    expect(ok?.metadata?.metadata.entitySets.map((e) => e.name)).toContain('customers');
    const bad = results.find((r) => r.route.path === 'broken/route/v1.0');
    expect(bad?.error).toContain('metadata exploded');

    // Second discovery: the good route is served from cache (no new request),
    // while the failed route is retried since errors are never cached.
    const before = calls.filter((c) => c.url.includes('$metadata')).length;
    await client.discoverAll();
    const metadataCalls = calls.filter((c) => c.url.includes('$metadata'));
    expect(metadataCalls.length).toBe(before + 1);
    expect(metadataCalls.at(-1)?.url).toContain('broken/route/v1.0');

    const cached = await client.cachedMetadata();
    expect(cached.map((c) => c.routePath)).toEqual(['v2.0']);
  });
});

describe('findCompany', () => {
  const companies = [
    { id: COMPANY_ID, name: 'CRONUS', displayName: 'CRONUS International Ltd.' },
    { id: 'ffffffff-0000-0000-0000-000000000001', name: 'Other', displayName: 'Other Co' },
  ];

  it('matches by id, name, or displayName, case-insensitively', async () => {
    const { findCompany } = await import('../src/index.js');
    expect(findCompany(companies, COMPANY_ID)?.name).toBe('CRONUS');
    expect(findCompany(companies, 'cronus')?.name).toBe('CRONUS');
    expect(findCompany(companies, 'other co')?.name).toBe('Other');
    expect(findCompany(companies, 'nope')).toBeUndefined();
  });

  it('companyLabel skips present-but-empty strings (real BC does this)', async () => {
    const { companyLabel } = await import('../src/index.js');
    expect(companyLabel({ id: 'g', name: 'CRONUS CH', displayName: '' })).toBe('CRONUS CH');
    expect(companyLabel({ id: 'g', name: '', displayName: '  ' })).toBe('g');
    expect(companyLabel({ displayName: 'Nice Name', name: 'X' })).toBe('Nice Name');
    expect(companyLabel({})).toBe('(unnamed)');
  });
});

describe('BcClient companies', () => {
  it('resolves a company by displayName and caches the id', async () => {
    const { client, calls } = makeClient([
      COMPANIES_ROUTE,
      { match: '/customers', body: { value: [] } },
    ]);
    await client.list('customers');
    await client.list('customers');
    expect(calls.filter((c) => c.url.endsWith('/v2.0/companies'))).toHaveLength(1);
    const custCall = calls.find((c) => c.url.includes('customers'));
    expect(custCall?.url).toContain(`companies(${COMPANY_ID})/customers`);
  });

  it('uses a GUID company without lookup', async () => {
    const { client, calls } = makeClient(
      [{ match: '/customers', body: { value: [] } }],
      COMPANY_ID,
    );
    await client.list('customers');
    expect(calls).toHaveLength(1);
  });

  it('throws a helpful error for unknown companies', async () => {
    const { client } = makeClient([COMPANIES_ROUTE], 'Nope Inc');
    await expect(client.list('customers')).rejects.toThrow(/Company "Nope Inc" not found/);
  });

  it('throws when no company is configured at all', async () => {
    const { client } = makeClient([], '');
    await expect(client.list('customers')).rejects.toThrow(/No company specified/);
  });
});

describe('BcClient list pagination', () => {
  it('reads published ODataV4 services through Company(Id=guid)', async () => {
    const { client, calls } = makeClient(
      [{ match: '/ODataV4/Company(Id=', body: { value: [{ No: '10000' }] } }],
      COMPANY_ID,
    );

    const result = await client.list('Customer', {
      route: ODATA_V4_ROUTE,
      query: { select: ['No', 'Name'], filter: "Blocked eq ' '", top: 10 },
      maxPageSize: 25,
    });

    expect(result.items).toEqual([{ No: '10000' }]);
    expect(calls[0].url).toBe(
      `${ODATA}/Company(Id=${COMPANY_ID})/Customer` +
        `?$filter=Blocked%20eq%20'%20'&$select=No%2CName&$top=10`,
    );
    expect(calls[0].headers.prefer).toBe('odata.maxpagesize=25');
  });

  it('reads the ODataV4 Company entity set without nesting it under a company', async () => {
    const { client, calls } = makeClient([
      { match: (url) => url === `${ODATA}/Company?$top=1`, body: { value: [{ Name: 'CRONUS' }] } },
    ]);

    const result = await client.list('Company', {
      route: ODATA_V4_ROUTE,
      query: { top: 1 },
    });

    expect(result.items).toEqual([{ Name: 'CRONUS' }]);
    expect(calls[0].url).toBe(`${ODATA}/Company?$top=1`);
  });

  it('includes the attempted URL when an ODataV4 read fails', async () => {
    const { client } = makeClient(
      [
        {
          match: '/ODataV4/Company(Id=',
          status: 404,
          body: { error: { code: 'NotFound', message: 'missing service' } },
        },
      ],
      COMPANY_ID,
    );

    await expect(
      client.list('MissingService', { route: ODATA_V4_ROUTE, query: { top: 1 } }),
    ).rejects.toThrow(`${ODATA}/Company(Id=${COMPANY_ID})/MissingService?$top=1`);
  });

  it('returns first page plus nextLink by default', async () => {
    const next = `${API}/v2.0/companies(${COMPANY_ID})/customers?$skiptoken=abc`;
    const { client } = makeClient([
      COMPANIES_ROUTE,
      {
        match: (u) => u.includes('/customers') && !u.includes('skiptoken'),
        body: { value: [{ id: '1' }], '@odata.nextLink': next },
      },
    ]);
    const result = await client.list('customers');
    expect(result.items).toHaveLength(1);
    expect(result.nextLink).toBe(next);
  });

  it('getNavigation handles collection and single-valued navigations', async () => {
    const { client } = makeClient([
      COMPANIES_ROUTE,
      {
        method: 'GET',
        match: `customers(${CUSTOMER_ID})/shipments`,
        body: { value: [{ number: 'SH-1' }, { number: 'SH-2' }] },
      },
      {
        method: 'GET',
        match: `customers(${CUSTOMER_ID})/currency`,
        body: { id: 'cur-1', code: 'USD' },
      },
    ]);
    const shipments = await client.getNavigation('customers', CUSTOMER_ID, 'shipments');
    expect(shipments.kind).toBe('collection');
    expect(shipments.items.map((s) => s.number)).toEqual(['SH-1', 'SH-2']);

    const currency = await client.getNavigation('customers', CUSTOMER_ID, 'currency');
    expect(currency.kind).toBe('record');
    expect(currency.items[0].code).toBe('USD');
  });

  it('captures @odata.count and exposes the built URL', async () => {
    const { client } = makeClient([
      COMPANIES_ROUTE,
      {
        match: '$count=true',
        body: { value: [{ id: '1' }], '@odata.count': 1203 },
      },
    ]);
    const query = { top: 50, count: true, filter: "blocked eq ''", select: ['number'] };
    const result = await client.list('customers', { query });
    expect(result.count).toBe(1203);

    const url = await client.buildListUrl('customers', { query });
    expect(url).toBe(
      `${API}/v2.0/companies(${COMPANY_ID})/customers` +
        `?$filter=blocked%20eq%20''&$select=number&$top=50&$count=true`,
    );
  });

  it('maxPageSize sends the odata.maxpagesize preference (unlike $top, it pages)', async () => {
    const { client, calls } = makeClient([
      COMPANIES_ROUTE,
      { match: '/customers', body: { value: [] } },
    ]);
    await client.list('customers', { maxPageSize: 50 });
    const listCall = calls.find((c) => c.url.includes('/customers'));
    expect(listCall?.headers.prefer).toBe('odata.maxpagesize=50');

    await client.followNextLink(`${API}/v2.0/companies(${COMPANY_ID})/customers?x=1`, {
      maxPageSize: 50,
    });
    expect(calls[calls.length - 1].headers.prefer).toBe('odata.maxpagesize=50');
  });

  it('followNextLink continues from a prior page', async () => {
    const next = `${API}/v2.0/companies(${COMPANY_ID})/customers?$skiptoken=abc`;
    const { client } = makeClient([
      { match: '$skiptoken=abc', body: { value: [{ id: '2' }, { id: '3' }] } },
    ]);
    const page = await client.followNextLink(next);
    expect(page.items.map((i) => i.id)).toEqual(['2', '3']);
    expect(page.nextLink).toBeUndefined();
  });

  it('follows nextLink to the end with all: true', async () => {
    const next = `${API}/v2.0/companies(${COMPANY_ID})/customers?$skiptoken=abc`;
    const { client } = makeClient([
      COMPANIES_ROUTE,
      { match: '$skiptoken=abc', body: { value: [{ id: '2' }] } },
      {
        match: (u) => u.includes('/customers') && !u.includes('skiptoken'),
        body: { value: [{ id: '1' }], '@odata.nextLink': next },
      },
    ]);
    const result = await client.list('customers', { all: true });
    expect(result.items.map((i) => i.id)).toEqual(['1', '2']);
    expect(result.nextLink).toBeUndefined();
  });
});

describe('BcClient ETag handling', () => {
  it('creates records through published writable ODataV4 pages', async () => {
    const { client, calls } = makeClient(
      [
        {
          method: 'POST',
          match: '/ODataV4/Company(Id=',
          body: { No: '10000', Name: 'Adatum' },
        },
      ],
      COMPANY_ID,
    );

    const result = await client.create(
      'Customer',
      { No: '10000', Name: 'Adatum' },
      { route: ODATA_V4_ROUTE },
    );

    expect(result.Name).toBe('Adatum');
    expect(calls[0].url).toBe(`${ODATA}/Company(Id=${COMPANY_ID})/Customer`);
  });

  it('updates ODataV4 records addressed by composite keys', async () => {
    const key = { Document_Type: 'Order', Document_No: 'SO-1', Line_No: 10000 };
    const keyExpression = "Document_Type='Order',Document_No='SO-1',Line_No=10000";
    const { client, calls } = makeClient(
      [
        {
          method: 'GET',
          match: `SalesLine(${keyExpression})`,
          body: { '@odata.etag': 'W/"line-1"', Quantity: 1 },
        },
        {
          method: 'PATCH',
          match: `SalesLine(${keyExpression})`,
          body: { '@odata.etag': 'W/"line-2"', Quantity: 2 },
        },
      ],
      COMPANY_ID,
    );

    const result = await client.update(
      'SalesLine',
      key,
      { Quantity: 2 },
      { route: ODATA_V4_ROUTE },
    );

    expect(result.Quantity).toBe(2);
    expect(calls[1].headers['if-match']).toBe('W/"line-1"');
  });

  it('deletes ODataV4 records addressed by named string keys', async () => {
    const { client, calls } = makeClient(
      [
        {
          method: 'GET',
          match: "Customer(No='10000')",
          body: { '@odata.etag': 'W/"customer-1"', No: '10000' },
        },
        { method: 'DELETE', match: "Customer(No='10000')" },
      ],
      COMPANY_ID,
    );

    await client.deleteRecord('Customer', { No: '10000' }, { route: ODATA_V4_ROUTE });

    expect(calls[1].headers['if-match']).toBe('W/"customer-1"');
  });

  const recordUrl = `${API}/v2.0/companies(${COMPANY_ID})/customers(${CUSTOMER_ID})`;

  it('GETs the record for its ETag, then PATCHes with If-Match', async () => {
    const { client, calls } = makeClient([
      COMPANIES_ROUTE,
      {
        method: 'GET',
        match: `customers(${CUSTOMER_ID})`,
        body: { id: CUSTOMER_ID, '@odata.etag': 'W/"etag-1"' },
      },
      {
        method: 'PATCH',
        match: `customers(${CUSTOMER_ID})`,
        body: { id: CUSTOMER_ID, blocked: 'All' },
      },
    ]);

    const updated = await client.update('customers', CUSTOMER_ID, { blocked: 'All' });
    expect(updated.blocked).toBe('All');
    const patchCall = calls.find((c) => c.method === 'PATCH');
    expect(patchCall?.url).toBe(recordUrl);
    expect(patchCall?.headers['if-match']).toBe('W/"etag-1"');
  });

  it('on 412, refreshes the ETag and retries exactly once', async () => {
    const { client, calls } = makeClient([
      COMPANIES_ROUTE,
      {
        method: 'GET',
        match: `customers(${CUSTOMER_ID})`,
        body: { id: CUSTOMER_ID, '@odata.etag': 'W/"stale"' },
        times: 1,
      },
      {
        method: 'PATCH',
        match: `customers(${CUSTOMER_ID})`,
        status: 412,
        body: { error: { code: 'Conflict', message: 'etag mismatch' } },
        times: 1,
      },
      {
        method: 'GET',
        match: `customers(${CUSTOMER_ID})`,
        body: { id: CUSTOMER_ID, '@odata.etag': 'W/"fresh"' },
        times: 1,
      },
      {
        method: 'PATCH',
        match: `customers(${CUSTOMER_ID})`,
        body: { id: CUSTOMER_ID, blocked: 'All' },
      },
    ]);

    const updated = await client.update('customers', CUSTOMER_ID, { blocked: 'All' });
    expect(updated.blocked).toBe('All');
    const patches = calls.filter((c) => c.method === 'PATCH');
    expect(patches).toHaveLength(2);
    expect(patches[1].headers['if-match']).toBe('W/"fresh"');
  });

  it('surfaces the conflict when the retry also hits 412', async () => {
    const { client } = makeClient([
      COMPANIES_ROUTE,
      {
        method: 'GET',
        match: `customers(${CUSTOMER_ID})`,
        body: { id: CUSTOMER_ID, '@odata.etag': 'W/"stale"' },
      },
      {
        method: 'PATCH',
        match: `customers(${CUSTOMER_ID})`,
        status: 412,
        body: { error: { code: 'Conflict', message: 'still fighting' } },
      },
    ]);

    await expect(
      client.update('customers', CUSTOMER_ID, { blocked: 'All' }),
    ).rejects.toBeInstanceOf(PreconditionFailedError);
  });

  it('delete uses the same ETag flow', async () => {
    const { client, calls } = makeClient([
      COMPANIES_ROUTE,
      {
        method: 'GET',
        match: `customers(${CUSTOMER_ID})`,
        body: { id: CUSTOMER_ID, '@odata.etag': 'W/"e"' },
      },
      { method: 'DELETE', match: `customers(${CUSTOMER_ID})`, status: 204 },
    ]);

    await client.deleteRecord('customers', CUSTOMER_ID);
    const del = calls.find((c) => c.method === 'DELETE');
    expect(del?.headers['if-match']).toBe('W/"e"');
  });
});

describe('BcClient create', () => {
  it('POSTs to the company-scoped collection', async () => {
    const { client, calls } = makeClient([
      COMPANIES_ROUTE,
      { method: 'POST', match: '/customers', status: 201, body: { id: 'new-1' } },
    ]);
    const created = await client.create('customers', { displayName: 'New Co' });
    expect(created.id).toBe('new-1');
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.body).toBe(JSON.stringify({ displayName: 'New Co' }));
  });
});
