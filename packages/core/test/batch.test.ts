import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BcClient, MetadataCache, StaticTokenProvider } from '../src/index.js';
import { SAMPLE_EDMX } from './fixtures/edmx.js';
import { type MockRoute, mockFetch } from './helpers.js';

const COMPANY_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ORDER_ID = '99999999-a0b0-e011-8fb2-78e7d1625bd8';
const API = 'https://api.businesscentral.dynamics.com/v2.0/tenant-1/Sandbox/api';

const COMPANIES_ROUTE: MockRoute = {
  method: 'GET',
  match: (u) => u.endsWith('/v2.0/companies'),
  body: { value: [{ id: COMPANY_ID, name: 'CRONUS', displayName: 'CRONUS International Ltd.' }] },
};

let tmpDir: string;

function makeClient(routes: MockRoute[]) {
  const { fetchImpl, calls } = mockFetch(routes);
  const cache = new MetadataCache(tmpDir);
  const client = new BcClient({
    profile: {
      name: 'test',
      tenantId: 'tenant-1',
      clientId: 'c',
      environment: 'Sandbox',
      company: 'CRONUS',
    },
    auth: new StaticTokenProvider('tok'),
    fetch: fetchImpl,
    cache,
    sleep: () => Promise.resolve(),
  });
  return { client, calls, cache };
}

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'navapi-batch-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('BcClient.batch', () => {
  it('POSTs a JSON batch with ids assigned and {company} resolved', async () => {
    const { client, calls } = makeClient([
      COMPANIES_ROUTE,
      {
        method: 'POST',
        match: '/v2.0/$batch',
        body: {
          responses: [
            { id: '1', status: 200, body: { value: [] } },
            { id: 'upd', status: 200, body: { blocked: 'All' } },
          ],
        },
      },
    ]);

    const responses = await client.batch([
      { method: 'GET', url: 'companies({company})/customers?$top=1' },
      {
        method: 'PATCH',
        url: 'companies({company})/customers(x)',
        id: 'upd',
        body: { blocked: 'All' },
        headers: { 'if-match': '*' },
      },
    ]);

    const batchCall = calls.find((c) => c.url.endsWith('/$batch'));
    expect(batchCall).toBeDefined();
    const payload = JSON.parse(batchCall?.body ?? '{}');
    expect(payload.requests).toHaveLength(2);
    expect(payload.requests[0]).toMatchObject({
      id: '1',
      method: 'GET',
      url: `companies(${COMPANY_ID})/customers?$top=1`,
    });
    expect(payload.requests[1]).toMatchObject({
      id: 'upd',
      headers: { 'content-type': 'application/json', 'if-match': '*' },
      body: { blocked: 'All' },
    });

    expect(responses).toEqual([
      { id: '1', status: 200, ok: true, body: { value: [] } },
      { id: 'upd', status: 200, ok: true, body: { blocked: 'All' } },
    ]);
  });

  it('marks failed sub-requests without throwing, in request order', async () => {
    const { client } = makeClient([
      {
        method: 'POST',
        match: '/$batch',
        body: {
          responses: [
            { id: '2', status: 400, body: { error: { code: 'Bad', message: 'nope' } } },
            { id: '1', status: 201, body: { id: 'ok' } },
          ],
        },
      },
    ]);

    const responses = await client.batch([
      { method: 'POST', url: 'foo', body: {} },
      { method: 'POST', url: 'bar', body: {} },
    ]);
    expect(responses.map((r) => r.id)).toEqual(['1', '2']);
    expect(responses[0].ok).toBe(true);
    expect(responses[1].ok).toBe(false);
    expect(responses[1].status).toBe(400);
  });

  it('skips company resolution when no URL needs it and passes atomicityGroup', async () => {
    const { client, calls } = makeClient([
      { method: 'POST', match: '/$batch', body: { responses: [{ id: 'a', status: 204 }] } },
    ]);
    await client.batch([
      { method: 'DELETE', url: 'companies(x)/customers(y)', id: 'a', atomicityGroup: 'g1' },
    ]);
    expect(calls).toHaveLength(1); // no companies lookup
    const payload = JSON.parse(calls[0].body ?? '{}');
    expect(payload.requests[0].atomicityGroup).toBe('g1');
  });
});

describe('BcClient.callAction', () => {
  it('qualifies bare action names with the cached metadata namespace', async () => {
    const { client, cache, calls } = makeClient([
      COMPANIES_ROUTE,
      {
        method: 'POST',
        match: 'Microsoft.NAV.shipAndInvoice',
        status: 204,
      },
    ]);
    await cache.set('test', 'v2.0', { namespace: 'Microsoft.NAV', entitySets: [] });

    const result = await client.callAction('salesOrders', ORDER_ID, 'shipAndInvoice');
    expect(result).toBeUndefined();
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe(
      `${API}/v2.0/companies(${COMPANY_ID})/salesOrders(${ORDER_ID})/Microsoft.NAV.shipAndInvoice`,
    );
  });

  it('uses fully qualified names as-is and passes parameters', async () => {
    const { client, calls } = makeClient([
      COMPANIES_ROUTE,
      { method: 'POST', match: 'Contoso.Custom.doThing', body: { done: true } },
    ]);
    const result = await client.callAction('salesOrders', ORDER_ID, 'Contoso.Custom.doThing', {
      parameters: { qty: 2 },
    });
    expect(result).toEqual({ done: true });
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.body).toBe(JSON.stringify({ qty: 2 }));
  });

  it('falls back to Microsoft.NAV when nothing is cached', async () => {
    const { client, calls } = makeClient([
      COMPANIES_ROUTE,
      { method: 'POST', match: 'Microsoft.NAV.release', status: 204 },
    ]);
    await client.callAction('salesOrders', ORDER_ID, 'release');
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toContain('/Microsoft.NAV.release');
  });
});

describe('metadata namespace round-trip', () => {
  it('cached EDMX namespace feeds action qualification', async () => {
    const { client, cache, calls } = makeClient([
      COMPANIES_ROUTE,
      { match: '/v2.0/$metadata', body: SAMPLE_EDMX },
      { method: 'POST', match: 'shipAndInvoice', status: 204 },
    ]);
    await client.getMetadata('v2.0');
    await client.callAction('salesOrders', ORDER_ID, 'shipAndInvoice');
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toContain('/Microsoft.NAV.shipAndInvoice');
    expect(cache).toBeDefined();
  });
});
