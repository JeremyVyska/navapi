import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BcClient,
  BraiderClient,
  type BraiderInfo,
  decodeODataName,
  detectBraider,
  encodeJsonInput,
  encodeODataName,
  MetadataCache,
  NavApiError,
  parseBraiderFilterSpec,
  parseJsonResult,
  StaticTokenProvider,
} from '../src/index.js';
import { BRAIDER_EDMX_LEVEL1, BRAIDER_EDMX_LEVEL2 } from './fixtures/braider-edmx.js';
import { type MockRoute, mockFetch } from './helpers.js';

const COMPANY_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const API = 'https://api.businesscentral.dynamics.com/v2.0/tenant-1/Sandbox/api';
const BRAIDER = `${API}/sparebrained/databraider/v2.0/companies(${COMPANY_ID})`;

const COMPANIES_ROUTE: MockRoute = {
  method: 'GET',
  match: (u) => u.endsWith('/v2.0/companies'),
  body: { value: [{ id: COMPANY_ID, name: 'CRONUS', displayName: 'CRONUS International Ltd.' }] },
};

let tmpDir: string;

function makeClient(routes: MockRoute[]) {
  const { fetchImpl, calls } = mockFetch(routes);
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
    cache: new MetadataCache(tmpDir),
    sleep: () => Promise.resolve(),
  });
  return { client, calls };
}

function braiderInfo(overrides: Partial<BraiderInfo> = {}): BraiderInfo {
  return {
    routePath: 'sparebrained/databraider/v2.0',
    version: 'v2.0',
    level: 'config',
    entitySets: ['read', 'write'],
    configSets: {
      configs: 'endpointConfigs',
      lines: 'endpointLines',
      fields: 'endpointFields',
      relations: 'endpointRelations',
      schemas: 'endpointSchemas',
      tables: 'availableTables',
      fieldsLookup: 'availableFields',
    },
    ...overrides,
  };
}

function level1Info(): BraiderInfo {
  return braiderInfo({ level: 'readwrite', configSets: {} });
}

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'navapi-braider-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ------------------------------------------------------------ pure helpers

describe('parseJsonResult', () => {
  it('returns [] for empty/whitespace/null', () => {
    expect(parseJsonResult('').records).toEqual([]);
    expect(parseJsonResult('   ').records).toEqual([]);
    expect(parseJsonResult(null).records).toEqual([]);
    expect(parseJsonResult(undefined).records).toEqual([]);
  });

  it('parses a double-encoded flat array', () => {
    const raw = JSON.stringify([{ 'Customer.No': '10000', 'Customer.Name': 'Adatum' }]);
    expect(parseJsonResult(raw).records).toEqual([
      { 'Customer.No': '10000', 'Customer.Name': 'Adatum' },
    ]);
  });

  it('unwraps the {data, diagnostics} envelope', () => {
    const raw = JSON.stringify({
      data: [{ 'Customer.No': '10000' }],
      diagnostics: { rowCount: 1, colCount: 1 },
    });
    const result = parseJsonResult(raw);
    expect(result.records).toEqual([{ 'Customer.No': '10000' }]);
    expect(result.diagnostics).toEqual({ rowCount: 1, colCount: 1 });
  });

  it('surfaces Braider error blobs as NavApiError', () => {
    const raw = JSON.stringify([
      {
        Row: 1,
        Column: 0,
        Error: true,
        Detail: 'The requested page is beyond the records that exist',
      },
    ]);
    expect(() => parseJsonResult(raw)).toThrow(/beyond the records/);
    expect(() => parseJsonResult(raw)).toThrow(NavApiError);
  });

  it('throws with a snippet on malformed JSON', () => {
    expect(() => parseJsonResult('{"oops": ')).toThrow(/not valid JSON.*\{"oops":/s);
  });

  it('rejects non-string jsonResult', () => {
    expect(() => parseJsonResult(42)).toThrow(/Expected jsonResult to be a string/);
  });
});

describe('filter DSL + encoders', () => {
  it('parses Table.Field=range with dotted field names', () => {
    expect(parseBraiderFilterSpec('Customer.No.=10000..20000')).toEqual({
      table: 'Customer',
      field: 'No.',
      filter: '10000..20000',
    });
  });

  it('keeps everything after the first = as the filter', () => {
    expect(parseBraiderFilterSpec("Customer.Name=<>''")).toEqual({
      table: 'Customer',
      field: 'Name',
      filter: "<>''",
    });
    expect(parseBraiderFilterSpec('Item.Description=A=B')).toEqual({
      table: 'Item',
      field: 'Description',
      filter: 'A=B',
    });
  });

  it('passes numeric table/field ids through as numbers', () => {
    expect(parseBraiderFilterSpec('18.1=10000')).toEqual({ table: 18, field: 1, filter: '10000' });
  });

  it('rejects specs without = or Table.Field', () => {
    expect(() => parseBraiderFilterSpec('Customer.No.')).toThrow(/Expected Table\.Field=filter/);
    expect(() => parseBraiderFilterSpec('Customer=10000')).toThrow(/Table\.Field/);
    expect(() => parseBraiderFilterSpec('Customer.No.=')).toThrow(/empty/);
  });

  it('encodeJsonInput fills defaultAction and validates', () => {
    const out = JSON.parse(encodeJsonInput([{ 'Customer.Name': 'X' }], 'Insert'));
    expect(out).toEqual([{ 'Customer.Name': 'X', Action: 'Insert' }]);
    expect(() => encodeJsonInput([{ 'Customer.Name': 'X' }])).toThrow(/no "Action"/);
    expect(() => encodeJsonInput([{ Action: 'Zap' as never, 'Customer.Name': 'X' }])).toThrow(
      /invalid Action "Zap"/,
    );
  });

  it('round-trips OData-encoded enum names', () => {
    expect(decodeODataName('Per_x0020_Record')).toBe('Per Record');
    expect(decodeODataName('Read_x0020_Only')).toBe('Read Only');
    expect(encodeODataName('Per Record')).toBe('Per_x0020_Record');
  });
});

// -------------------------------------------------------------- detection

describe('detectBraider', () => {
  const ROUTES: MockRoute = {
    method: 'GET',
    match: '/apiRoutes',
    body: {
      value: [
        {
          publisher: 'microsoft',
          group: 'automation',
          version: 'v2.0',
          route: 'microsoft/automation/v2.0',
        },
        {
          publisher: 'sparebrained',
          group: 'databraider',
          version: 'v2.0',
          route: 'sparebrained/databraider/v2.0',
        },
      ],
    },
  };

  it('detects level 1 (read/write only)', async () => {
    const { client } = makeClient([
      COMPANIES_ROUTE,
      ROUTES,
      {
        method: 'GET',
        match: '/sparebrained/databraider/v2.0/$metadata',
        body: BRAIDER_EDMX_LEVEL1,
      },
    ]);
    const info = await detectBraider(client);
    expect(info).toMatchObject({
      routePath: 'sparebrained/databraider/v2.0',
      version: 'v2.0',
      level: 'readwrite',
    });
    expect(info?.configSets).toEqual({});
  });

  it('detects level 2 (config API present) with tolerant set matching', async () => {
    const { client } = makeClient([
      COMPANIES_ROUTE,
      ROUTES,
      {
        method: 'GET',
        match: '/sparebrained/databraider/v2.0/$metadata',
        body: BRAIDER_EDMX_LEVEL2,
      },
    ]);
    const info = await detectBraider(client);
    expect(info?.level).toBe('config');
    expect(info?.configSets).toMatchObject({
      configs: 'endpointConfigs',
      lines: 'endpointLines',
      fields: 'endpointFields',
      schemas: 'endpointSchemas',
      tables: 'availableTables',
      fieldsLookup: 'availableFields',
    });
  });

  it('returns undefined when Braider is not installed', async () => {
    const { client } = makeClient([
      COMPANIES_ROUTE,
      {
        method: 'GET',
        match: '/apiRoutes',
        body: { value: [{ route: 'v2.0' }] },
      },
    ]);
    expect(await detectBraider(client)).toBeUndefined();
  });

  it('prefers the offline metadata cache over live enumeration', async () => {
    const cache = new MetadataCache(tmpDir);
    const seed = makeClient([
      COMPANIES_ROUTE,
      ROUTES,
      { method: 'GET', match: '/$metadata', body: BRAIDER_EDMX_LEVEL2 },
    ]);
    await seed.client.getMetadata('sparebrained/databraider/v2.0');

    // No route/metadata mocks: any network call would throw "unmatched request".
    const { client } = makeClient([]);
    const info = await detectBraider(client);
    expect(info?.level).toBe('config');
    void cache;
  });

  it('prefers the highest version among cached Braider routes', async () => {
    const seed = makeClient([
      COMPANIES_ROUTE,
      ROUTES,
      { method: 'GET', match: '/$metadata', body: BRAIDER_EDMX_LEVEL1 },
    ]);
    await seed.client.getMetadata('sparebrained/databraider/v2.0');
    const seed2 = makeClient([{ method: 'GET', match: '/$metadata', body: BRAIDER_EDMX_LEVEL2 }]);
    await seed2.client.getMetadata('sparebrained/databraider/v3.0');

    const { client } = makeClient([]);
    const info = await detectBraider(client);
    expect(info?.routePath).toBe('sparebrained/databraider/v3.0');
    expect(info?.version).toBe('v3.0');
  });
});

// ------------------------------------------------------------------ reads

describe('BraiderClient reads', () => {
  it('uses plain GET for a simple read and unwraps jsonResult', async () => {
    const { client, calls } = makeClient([
      COMPANIES_ROUTE,
      {
        method: 'GET',
        match: `${BRAIDER}/read('CUSTOMERS')`,
        body: {
          code: 'CUSTOMERS',
          jsonResult: JSON.stringify([{ 'Customer.No': '10000' }]),
          pageStart: 1,
          pageSize: 100,
          topLevelRecordCount: 1,
          includedRecordCount: 1,
        },
      },
    ]);
    const braider = new BraiderClient(client, level1Info());
    const result = await braider.readEndpoint('CUSTOMERS');
    expect(result.records).toEqual([{ 'Customer.No': '10000' }]);
    expect(result.hasMore).toBe(false);
    expect(result.raw).toBeUndefined();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('POSTs with STRINGIFIED filterJson when filters are given', async () => {
    const { client, calls } = makeClient([
      COMPANIES_ROUTE,
      {
        method: 'POST',
        match: `${BRAIDER}/read`,
        body: {
          code: 'CUSTOMERS',
          jsonResult: '[]',
          pageStart: 1,
          pageSize: 100,
          topLevelRecordCount: 0,
        },
      },
    ]);
    const braider = new BraiderClient(client, level1Info());
    await braider.readEndpoint('CUSTOMERS', {
      filters: [{ table: 'Customer', field: 'No.', filter: '10000..20000' }],
    });
    const post = calls.find((c) => c.method === 'POST');
    const body = JSON.parse(post?.body ?? '{}');
    expect(typeof body.filterJson).toBe('string');
    expect(JSON.parse(body.filterJson)).toEqual([
      { table: 'Customer', field: 'No.', filter: '10000..20000' },
    ]);
  });

  it('reports hasMore from pageStart/pageSize vs topLevelRecordCount', async () => {
    const { client } = makeClient([
      COMPANIES_ROUTE,
      {
        method: 'POST',
        match: `${BRAIDER}/read`,
        body: {
          code: 'CUSTOMERS',
          jsonResult: JSON.stringify([{ 'Customer.No': '10000' }]),
          pageStart: 1,
          pageSize: 2,
          topLevelRecordCount: 5,
        },
      },
    ]);
    const braider = new BraiderClient(client, level1Info());
    const result = await braider.readEndpoint('CUSTOMERS', { pageSize: 2 });
    expect(result.hasMore).toBe(true);
  });

  it('all: pages bounded by topLevelRecordCount, never past the end', async () => {
    const page = (records: unknown[], pageStart: number) => ({
      method: 'POST' as const,
      match: `${BRAIDER}/read`,
      times: 1,
      body: {
        code: 'CUSTOMERS',
        jsonResult: JSON.stringify(records),
        pageStart,
        pageSize: 2,
        topLevelRecordCount: 5,
        includedRecordCount: records.length,
      },
    });
    const { client, calls } = makeClient([
      COMPANIES_ROUTE,
      page([{ n: 1 }, { n: 2 }], 1),
      page([{ n: 3 }, { n: 4 }], 2),
      page([{ n: 5 }], 3),
    ]);
    const braider = new BraiderClient(client, level1Info());
    const result = await braider.readEndpoint('CUSTOMERS', { all: true, pageSize: 2 });
    expect(result.records).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }]);
    expect(result.hasMore).toBe(false);
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(3); // exactly ceil(5/2), never a 4th probe
    expect(JSON.parse(posts[2].body ?? '{}').pageStart).toBe(3);
  });

  it('lists endpoints with decoded enums', async () => {
    const { client } = makeClient([
      COMPANIES_ROUTE,
      {
        method: 'GET',
        match: `${BRAIDER}/read`,
        body: {
          value: [
            {
              code: 'CUSTOMERS',
              description: 'All customers',
              endpointType: 'Read_x0020_Only',
              outputJSONType: 'Flat',
            },
          ],
        },
      },
    ]);
    const braider = new BraiderClient(client, level1Info());
    const endpoints = await braider.listEndpoints();
    expect(endpoints).toEqual([
      expect.objectContaining({
        code: 'CUSTOMERS',
        endpointType: 'Read Only',
        outputJsonType: 'Flat',
      }),
    ]);
  });
});

// ----------------------------------------------------------------- writes

describe('BraiderClient writes', () => {
  it('POSTs stringified jsonInput with If-Match: * and parses the result', async () => {
    const { client, calls } = makeClient([
      COMPANIES_ROUTE,
      {
        method: 'POST',
        match: `${BRAIDER}/write`,
        body: {
          code: 'CUST_W',
          jsonResult: JSON.stringify([
            { action: 'insert', data: [{ 'Customer.No': '10000' }] },
            { action: 'delete', gravestonePK: 'Customer: 20000' },
          ]),
        },
      },
    ]);
    const braider = new BraiderClient(client, level1Info());
    const results = await braider.writeEndpoint('CUST_W', [
      { Action: 'Insert', 'Customer.Name': 'Adatum' },
      { Action: 'Delete', 'Customer.No': '20000' },
    ]);
    const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/write'));
    expect(post?.headers['if-match']).toBe('*');
    const body = JSON.parse(post?.body ?? '{}');
    expect(typeof body.jsonInput).toBe('string');
    expect(JSON.parse(body.jsonInput)[0]).toMatchObject({ Action: 'Insert' });
    expect(results[1]).toMatchObject({ action: 'delete', gravestonePK: 'Customer: 20000' });
  });

  it('surfaces write error blobs as NavApiError', async () => {
    const { client } = makeClient([
      COMPANIES_ROUTE,
      {
        method: 'POST',
        match: `${BRAIDER}/write`,
        body: {
          code: 'CUST_W',
          jsonResult: JSON.stringify([
            { Row: 1, Column: 2, Error: true, Detail: 'Mandatory field Customer.Name is missing' },
          ]),
        },
      },
    ]);
    const braider = new BraiderClient(client, level1Info());
    await expect(braider.writeEndpoint('CUST_W', [{ Action: 'Insert' }])).rejects.toThrow(
      /Mandatory field Customer.Name/,
    );
  });

  it('rejects empty record arrays client-side', async () => {
    const { client } = makeClient([]);
    const braider = new BraiderClient(client, level1Info());
    await expect(braider.writeEndpoint('X', [])).rejects.toThrow(/at least one record/);
  });
});

// ----------------------------------------------------------------- schema

describe('BraiderClient schema', () => {
  it('uses the live schema API when present, with x-spb metadata', async () => {
    const readSchema = {
      type: 'object',
      properties: {
        'Customer.No': {
          type: 'string',
          'x-spb-tableNo': 18,
          'x-spb-fieldNo': 1,
          'x-spb-primaryKey': true,
          'x-spb-writeEnabled': false,
        },
        'Customer.Name': {
          type: 'string',
          'x-spb-tableNo': 18,
          'x-spb-fieldNo': 2,
          'x-spb-primaryKey': false,
          'x-spb-writeEnabled': true,
        },
      },
      required: ['Customer.No'],
    };
    const { client } = makeClient([
      COMPANIES_ROUTE,
      {
        method: 'GET',
        match: `${BRAIDER}/endpointSchemas('CUSTOMERS')`,
        body: {
          code: 'CUSTOMERS',
          endpointType: 'Read_x0020_Only',
          outputJSONType: 'Flat',
          readSchemaJson: JSON.stringify(readSchema),
          writeSchemaJson: '',
        },
      },
    ]);
    const braider = new BraiderClient(client, braiderInfo());
    const schema = await braider.getEndpointSchema('CUSTOMERS');
    expect(schema.source).toBe('api');
    expect(schema.endpointType).toBe('Read Only');
    expect(schema.writeSchema).toBeUndefined();
    expect(schema.readSchema).toEqual([
      {
        name: 'Customer.No',
        type: 'string',
        required: true,
        tableNo: 18,
        fieldNo: 1,
        writeEnabled: false,
        primaryKey: true,
      },
      {
        name: 'Customer.Name',
        type: 'string',
        required: false,
        tableNo: 18,
        fieldNo: 2,
        writeEnabled: true,
        primaryKey: false,
      },
    ]);
  });

  it('falls back to inference from flat sample data at level 1', async () => {
    const { client } = makeClient([
      COMPANIES_ROUTE,
      {
        method: 'POST',
        match: `${BRAIDER}/read`,
        body: {
          code: 'CUSTOMERS',
          jsonResult: JSON.stringify([
            { 'Customer.No': '10000', 'Customer.Balance': 12.5, 'Customer.Blocked': false },
          ]),
          pageStart: 1,
          pageSize: 25,
          topLevelRecordCount: 1,
        },
      },
    ]);
    const braider = new BraiderClient(client, level1Info());
    const schema = await braider.getEndpointSchema('CUSTOMERS');
    expect(schema.source).toBe('inferred');
    expect(schema.readSchema).toEqual(
      expect.arrayContaining([
        { name: 'Customer.No', type: 'string', required: false },
        { name: 'Customer.Balance', type: 'number', required: false },
        { name: 'Customer.Blocked', type: 'boolean', required: false },
      ]),
    );
  });

  it('infers Table.Field names from hierarchy nodes including children', async () => {
    const { client } = makeClient([
      COMPANIES_ROUTE,
      {
        method: 'POST',
        match: `${BRAIDER}/read`,
        body: {
          code: 'ORDERS',
          jsonResult: JSON.stringify([
            {
              level: 1,
              sourceTableNumber: 36,
              sourceTableName: 'SalesHeader',
              pkString: 'x',
              sourceSystemId: 'g',
              data: { No: 'SO-1' },
              children: [
                {
                  level: 2,
                  sourceTableNumber: 37,
                  sourceTableName: 'SalesLine',
                  pkString: 'y',
                  sourceSystemId: 'h',
                  data: { Amount: 42 },
                  children: [],
                },
              ],
            },
          ]),
          pageStart: 1,
          pageSize: 25,
          topLevelRecordCount: 1,
        },
      },
    ]);
    const braider = new BraiderClient(client, level1Info());
    const schema = await braider.getEndpointSchema('ORDERS');
    expect(schema.readSchema).toEqual(
      expect.arrayContaining([
        { name: 'SalesHeader.No', type: 'string', required: false },
        { name: 'SalesLine.Amount', type: 'number', required: false },
      ]),
    );
  });
});

// ------------------------------------------------------------ config CRUD

describe('BraiderClient config CRUD', () => {
  it('throws a clear error for config methods at level 1', async () => {
    const { client } = makeClient([]);
    const braider = new BraiderClient(client, level1Info());
    await expect(braider.listEndpointConfigs()).rejects.toThrow(/config API.*2\.4\+/s);
    await expect(
      braider.createEndpoint({ code: 'X', endpointType: 'Read Only', lines: [] }),
    ).rejects.toThrow(/config API/);
    await expect(braider.listAvailableTables()).rejects.toThrow(/config API/);
  });

  it('creates a full endpoint: config → lines → field patches', async () => {
    const CONFIG_ID = '11111111-1111-1111-1111-111111111111';
    const FIELD_NO_ID = '22222222-2222-2222-2222-222222222222';
    const FIELD_NAME_ID = '33333333-3333-3333-3333-333333333333';
    const { client, calls } = makeClient([
      COMPANIES_ROUTE,
      {
        method: 'POST',
        match: `${BRAIDER}/endpointConfigs`,
        body: { id: CONFIG_ID, code: 'SALESAPI', endpointType: 'Per_x0020_Record' },
      },
      {
        method: 'POST',
        match: `${BRAIDER}/endpointLines`,
        body: { id: 'line-1', configCode: 'SALESAPI', lineNo: 10000, sourceTable: 18 },
      },
      {
        method: 'GET',
        match: (u) =>
          u.includes('/endpointFields?') ||
          u.includes('/endpointFields%3F') ||
          u.includes('endpointFields'),
        body: {
          value: [
            { id: FIELD_NO_ID, fieldNo: 1, fieldName: 'No.', '@odata.etag': 'W/"e1"' },
            { id: FIELD_NAME_ID, fieldNo: 2, fieldName: 'Name', '@odata.etag': 'W/"e2"' },
          ],
        },
      },
      { method: 'PATCH', match: `(${FIELD_NO_ID})`, body: { id: FIELD_NO_ID, included: true } },
      { method: 'PATCH', match: `(${FIELD_NAME_ID})`, body: { id: FIELD_NAME_ID, included: true } },
    ]);
    const braider = new BraiderClient(client, braiderInfo());
    await braider.createEndpoint({
      code: 'SALESAPI',
      endpointType: 'Per Record',
      lines: [{ sourceTable: 18, includeFields: [1, { field: 'name', writeEnabled: true }] }],
    });

    const configPost = calls.find((c) => c.method === 'POST' && c.url.includes('endpointConfigs'));
    expect(JSON.parse(configPost?.body ?? '{}').endpointType).toBe('Per_x0020_Record');
    const linePost = calls.find((c) => c.method === 'POST' && c.url.includes('endpointLines'));
    expect(JSON.parse(linePost?.body ?? '{}')).toMatchObject({
      configCode: 'SALESAPI',
      sourceTable: 18,
    });
    const patches = calls.filter((c) => c.method === 'PATCH');
    expect(patches).toHaveLength(2);
    expect(patches[0].headers['if-match']).toBe('W/"e1"');
    expect(JSON.parse(patches[1].body ?? '{}')).toMatchObject({
      included: true,
      writeEnabled: true,
    });
  });

  it('names the failing step when creation dies midway', async () => {
    const { client } = makeClient([
      COMPANIES_ROUTE,
      {
        method: 'POST',
        match: `${BRAIDER}/endpointConfigs`,
        body: { id: 'cfg-1', code: 'SALESAPI' },
      },
      {
        method: 'POST',
        match: `${BRAIDER}/endpointLines`,
        status: 400,
        body: { error: { code: 'BadRequest', message: 'Source Table must have a value' } },
      },
    ]);
    const braider = new BraiderClient(client, braiderInfo());
    await expect(
      braider.createEndpoint({
        code: 'SALESAPI',
        endpointType: 'Read Only',
        lines: [{ sourceTable: 18, includeFields: [1] }],
      }),
    ).rejects.toThrow(/failed at step: create line 1.*partially created.*Source Table/s);
  });

  it('resolves table names via availableTables', async () => {
    const { client, calls } = makeClient([
      COMPANIES_ROUTE,
      {
        method: 'POST',
        match: `${BRAIDER}/endpointConfigs`,
        body: { id: 'cfg-1', code: 'C' },
      },
      {
        method: 'GET',
        match: 'availableTables',
        body: { value: [{ tableNo: 18, name: 'Customer', caption: 'Customer' }] },
      },
      {
        method: 'POST',
        match: `${BRAIDER}/endpointLines`,
        body: { id: 'line-1', lineNo: 10000 },
      },
      {
        method: 'GET',
        match: 'endpointFields',
        body: { value: [{ id: 'f1', fieldNo: 1, fieldName: 'No.', '@odata.etag': 'W/"e"' }] },
      },
      { method: 'PATCH', match: "('f1')", body: { id: 'f1' } },
    ]);
    const braider = new BraiderClient(client, braiderInfo());
    await braider.createEndpoint({
      code: 'C',
      endpointType: 'Read Only',
      lines: [{ sourceTable: 'Customer', includeFields: ['No.'] }],
    });
    const linePost = calls.find((c) => c.method === 'POST' && c.url.includes('endpointLines'));
    expect(JSON.parse(linePost?.body ?? '{}').sourceTable).toBe(18);
  });

  it('updateEndpoint resolves the config by code and encodes enums', async () => {
    const { client, calls } = makeClient([
      COMPANIES_ROUTE,
      {
        method: 'GET',
        match: 'endpointConfigs',
        body: { value: [{ id: 'cfg-9', code: 'CUSTOMERS', '@odata.etag': 'W/"c9"' }] },
      },
      { method: 'PATCH', match: "('cfg-9')", body: { id: 'cfg-9' } },
    ]);
    const braider = new BraiderClient(client, braiderInfo());
    await braider.updateEndpoint('CUSTOMERS', { endpointType: 'Per Record', enabled: true });
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.headers['if-match']).toBe('W/"c9"');
    expect(JSON.parse(patch?.body ?? '{}')).toEqual({
      endpointType: 'Per_x0020_Record',
      enabled: true,
    });
  });
});
