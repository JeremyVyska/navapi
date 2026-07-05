import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BcClient,
  MetadataCache,
  PreconditionFailedError,
  StaticTokenProvider,
} from '../src/index.js';
import { SAMPLE_EDMX } from './fixtures/edmx.js';
import { type MockRoute, mockFetch } from './helpers.js';

const COMPANY_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CUSTOMER_ID = '01121212-a0b0-e011-8fb2-78e7d1625bd8';
const API = 'https://api.businesscentral.dynamics.com/v2.0/tenant-1/Sandbox/api';

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
  it('prefers the runtime apiRoutes endpoint (company-scoped)', async () => {
    const { client, calls } = makeClient([
      COMPANIES_ROUTE,
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
      { match: '/apiRoutes', status: 404, body: { error: { code: 'NotFound', message: 'x' } } },
      { match: `${API}/routes`, status: 404, body: { error: { code: 'NotFound', message: 'x' } } },
    ]);
    const routes = await client.listRoutes();
    expect(routes).toEqual([{ path: 'v2.0', version: 'v2.0' }]);
  });

  it('discovers all routes, caches metadata, and reports per-route failures', async () => {
    const { client, calls } = makeClient([
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
