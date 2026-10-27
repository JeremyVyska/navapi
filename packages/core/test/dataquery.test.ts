import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDataQueryClientForSelector,
  DATA_QUERY_TOOLS,
  DataQueryClient,
  DataQueryUnavailableError,
  encodeMcpHeader,
  FileSecretStore,
  MCP_RESOURCE,
  ProfileStore,
  parseMcpBody,
  parseTableSchema,
  StaticTokenProvider,
} from '../src/index.js';

// Trimmed from a real BC 29.0 `bc_data_get_table_schema` response (CRLF, as sent).
const CUSTOMER_SCHEMA = [
  'Table: Customer (ID: 18)',
  'Primary Key: No.',
  'Showing: 5 fields (2 normal, 1 FlowField, 1 FlowFilter)',
  '',
  'No. | Code',
  'Post Code | Code | rel: Post Code [WHERE "Country/Region Code" = CONST("")]',
  'Partner Type | Option:  ,Company,Person',
  'Balance | Decimal | FlowField: Sum("Detailed Cust. Ledg. Entry"."Amount")',
  'Date Filter | Date | FlowFilter',
].join('\r\n');

interface Seen {
  method: string;
  params: Record<string, unknown>;
  headers: Record<string, string>;
}

type Handler = (method: string, params: Record<string, unknown>) => unknown;

/**
 * A scripted BC MCP server: answers JSON-RPC by method, as SSE the way the real
 * one does, and records every request. `tools/call` goes to `onTool`.
 */
function fakeMcp(
  onTool: (name: string, args: Record<string, unknown>) => unknown,
  opts: {
    tools?: readonly string[];
    failWith?: { status: number; body: unknown };
    on?: Handler;
  } = {},
) {
  const seen: Seen[] = [];
  let sessions = 0;
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    const msg = JSON.parse(String(init?.body)) as {
      id?: number;
      method: string;
      params?: Record<string, unknown>;
    };
    seen.push({ method: msg.method, params: msg.params ?? {}, headers });
    if (opts.failWith) {
      return new Response(JSON.stringify(opts.failWith.body), {
        status: opts.failWith.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (msg.method === 'notifications/initialized') return new Response(null, { status: 202 });
    const custom = opts.on?.(msg.method, msg.params ?? {});
    if (custom instanceof Response) return custom;
    let result: unknown;
    const extra: Record<string, string> = {};
    if (msg.method === 'initialize') {
      sessions++;
      extra['mcp-session-id'] = `s${sessions}`;
      result = { protocolVersion: '2025-11-25', capabilities: { tools: {} } };
    } else if (msg.method === 'tools/list') {
      result = { tools: (opts.tools ?? DATA_QUERY_TOOLS).map((name) => ({ name })) };
    } else if (msg.method === 'tools/call') {
      const p = msg.params as { name: string; arguments: Record<string, unknown> };
      result = onTool(p.name, p.arguments);
    }
    const body = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`;
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream', ...extra },
    });
  }) as typeof globalThis.fetch;
  return { fetchImpl, seen, sessions: () => sessions };
}

const text = (t: string) => ({ content: [{ type: 'text', text: t }] });

function client(fetchImpl: typeof globalThis.fetch, configurationName?: string) {
  return new DataQueryClient({
    auth: new StaticTokenProvider('tok'),
    target: { tenantId: 't1', environment: 'Dev', company: 'CRONUS USA, Inc.', configurationName },
    fetch: fetchImpl,
  });
}

describe('parseTableSchema', () => {
  it('reads fields, options, relations, and flow classes from the pipe format', () => {
    const schema = parseTableSchema(CUSTOMER_SCHEMA);
    expect(schema).toMatchObject({ tableId: 18, tableName: 'Customer', primaryKey: ['No.'] });
    expect(schema.fields).toEqual([
      { name: 'No.', type: 'Code', fieldClass: 'Normal' },
      {
        name: 'Post Code',
        type: 'Code',
        fieldClass: 'Normal',
        relation: 'Post Code [WHERE "Country/Region Code" = CONST("")]',
      },
      // The first option caption is a blank — it must survive as ''.
      {
        name: 'Partner Type',
        type: 'Option',
        fieldClass: 'Normal',
        options: ['', 'Company', 'Person'],
      },
      {
        name: 'Balance',
        type: 'Decimal',
        fieldClass: 'FlowField',
        calcFormula: 'Sum("Detailed Cust. Ledg. Entry"."Amount")',
      },
      { name: 'Date Filter', type: 'Date', fieldClass: 'FlowFilter' },
    ]);
  });

  it('refuses text that is not a schema rather than returning an empty one', () => {
    expect(() => parseTableSchema('Table with ID 9 not found.')).toThrow(/Unexpected table schema/);
  });
});

describe('MCP wire helpers', () => {
  it('base64-encodes non-ASCII header values only', () => {
    expect(encodeMcpHeader('CRONUS USA, Inc.')).toBe('CRONUS USA, Inc.');
    expect(encodeMcpHeader('Stefan Maroń Consulting')).toBe(
      `=?base64?${Buffer.from('Stefan Maroń Consulting').toString('base64')}?=`,
    );
  });

  it('takes the last data line of an SSE body, and plain JSON as is', () => {
    expect(
      parseMcpBody('event: message\ndata: {"id":1}\n\ndata: {"id":2}\n', 'text/event-stream'),
    ).toEqual({ id: 2 });
    expect(parseMcpBody('{"id":3}', 'application/json')).toEqual({ id: 3 });
  });
});

describe('DataQueryClient', () => {
  it('opens a session once and sends target headers on every request', async () => {
    const mcp = fakeMcp(() => text('{"tables":[{"tableId":18,"tableName":"Customer"}]}'));
    const dq = client(mcp.fetchImpl, 'navapi-dataquery');

    expect(await dq.findTables('customer')).toEqual([{ tableId: 18, tableName: 'Customer' }]);
    await dq.findTables('vendor', { semantic: true, top: 3 });

    expect(mcp.sessions()).toBe(1);
    expect(mcp.seen.map((s) => s.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
      'tools/call',
      'tools/call',
    ]);
    const call = mcp.seen[4] as Seen;
    expect(call.headers).toMatchObject({
      authorization: 'Bearer tok',
      tenantid: 't1',
      environmentname: 'Dev',
      company: 'CRONUS USA, Inc.',
      configurationname: 'navapi-dataquery',
      'mcp-session-id': 's1',
    });
    expect(call.params).toEqual({
      name: 'bc_data_find_tables',
      arguments: { searchText: 'vendor', searchMode: 'semantic', top: 3 },
    });
  });

  it('explains how to enable the feature when the configuration lacks the tools', async () => {
    const mcp = fakeMcp(() => text('{}'), { tools: ['bc_actions_search'] });
    const err = await client(mcp.fetchImpl)
      .findTables('x')
      .catch((e) => e);
    expect(err).toBeInstanceOf(DataQueryUnavailableError);
    expect(err.message).toMatch(/not enabled in the default MCP configuration/);
    expect(err.message).toContain('https://businesscentral.dynamics.com/t1/Dev?page=8350');
    expect(err.message).toMatch(/bills/);
    // Never a write: nothing past the listing was attempted.
    expect(mcp.seen.some((s) => s.method === 'tools/call')).toBe(false);
  });

  it('turns BC\'s "configuration not found" 400 into setup guidance', async () => {
    const mcp = fakeMcp(() => undefined, {
      failWith: {
        status: 400,
        body: {
          error: {
            code: 'BadRequest',
            message:
              'The MCP Configuration named nope was not found or not active. Please verify the configuration in Business Central.',
          },
        },
      },
    });
    const err = await client(mcp.fetchImpl, 'nope')
      .findTables('x')
      .catch((e) => e);
    expect(err).toBeInstanceOf(DataQueryUnavailableError);
    expect(err.message).toMatch(/MCP configuration "nope" was not found or is not active/);
  });

  it("surfaces tool errors (compile failures) with BC's own text", async () => {
    const mcp = fakeMcp(() => ({
      content: [{ type: 'text', text: 'Compilation failed:\n\n(1,64): error AL0345: …' }],
      isError: true,
    }));
    await expect(client(mcp.fetchImpl).validateQuery('query 50000 X {}')).rejects.toThrow(/AL0345/);
  });

  it("pages past BC's 50-row cap and stops at the requested top", async () => {
    const mcp = fakeMcp((_name, args) => {
      const skip = args.skip as number;
      const top = args.top as number;
      const rows = Array.from({ length: top }, (_, i) => [skip + i]);
      return {
        content: [
          { type: 'text', text: `Returned ${top} of 500 total records (skip=${skip}).` },
          {
            type: 'text',
            text: JSON.stringify({
              columns: ['N'],
              rows,
              ...(skip === 0 ? { totalCount: 500 } : {}),
            }),
          },
        ],
      };
    });
    const result = await client(mcp.fetchImpl).runQuery('q', { top: 120 });
    expect(result.rows).toHaveLength(120);
    expect(result.rows.at(-1)).toEqual([119]);
    expect(result.totalCount).toBe(500);
    const pages = mcp.seen
      .filter((s) => s.method === 'tools/call')
      .map((s) => s.params.arguments as { skip: number; top: number });
    expect(pages.map((p) => [p.skip, p.top])).toEqual([
      [0, 50],
      [50, 50],
      [100, 20],
    ]);
  });

  it('with all, stops once totalCount is reached without probing past it', async () => {
    const mcp = fakeMcp((_name, args) => {
      const skip = args.skip as number;
      const rows = Array.from({ length: Math.min(50, 70 - skip) }, (_, i) => [skip + i]);
      // A resource item, as BC sends for resultFormat=resource — parsed the same.
      return {
        content: [
          { type: 'text', text: 'summary' },
          {
            type: 'resource',
            resource: {
              text: JSON.stringify({
                columns: ['N'],
                rows,
                ...(skip === 0 ? { totalCount: 70 } : {}),
              }),
            },
          },
        ],
      };
    });
    const result = await client(mcp.fetchImpl).runQuery('q', { all: true });
    expect(result.rows).toHaveLength(70);
    expect(mcp.seen.filter((s) => s.method === 'tools/call')).toHaveLength(2);
  });

  it('resolves a table name exactly, and lists close matches when it cannot', async () => {
    const mcp = fakeMcp((name) =>
      name === 'bc_data_find_tables'
        ? text(
            '{"tables":[{"tableId":6,"tableName":"Customer Price Group"},{"tableId":18,"tableName":"Customer"}]}',
          )
        : text(CUSTOMER_SCHEMA),
    );
    const dq = client(mcp.fetchImpl);
    expect((await dq.getTableSchema('customer')).tableId).toBe(18);
    await expect(dq.resolveTableId('Cust')).rejects.toThrow(
      /Close matches: Customer Price Group \(6\)/,
    );
  });

  it('starts a new session once when BC says the old one expired', async () => {
    let expired = false;
    const mcp = fakeMcp(() => text('{"tables":[]}'), {
      on: (method) => {
        if (method === 'tools/call' && !expired) {
          expired = true;
          return new Response('', { status: 404 });
        }
        return undefined;
      },
    });
    expect(await client(mcp.fetchImpl).findTables('x')).toEqual([]);
    expect(mcp.sessions()).toBe(2);
  });
});

describe('createDataQueryClientForSelector', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'navapi-dq-'));
    vi.stubEnv('NAVAPI_SECRET_BACKEND', 'file');
    vi.stubEnv('NAVAPI_CLIENT_SECRET', undefined);
    vi.stubEnv('NAVAPI_PROFILE', undefined);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("asks Entra for an MCP-audience token with the profile's credential", async () => {
    const store = new ProfileStore(tmpDir);
    await store.upsertWithCredential(
      { name: 'dev', tenantId: 't1', environment: 'Dev', company: 'CRONUS USA, Inc.' },
      { name: 'app', type: 'clientSecret', clientId: 'c1' },
    );
    await new FileSecretStore(tmpDir).set('app', 's3cret');
    const scopes: string[] = [];
    const mcp = fakeMcp(() => text('{"tables":[]}'));
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('/oauth2/v2.0/token')) {
        scopes.push(new URLSearchParams(String(init?.body)).get('scope') ?? '');
        return new Response(JSON.stringify({ access_token: 'mcp-tok', expires_in: 3600 }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return mcp.fetchImpl(url, init);
    }) as typeof globalThis.fetch;

    const dq = await createDataQueryClientForSelector(
      { profile: 'dev', configurationName: 'cfg' },
      { configDir: tmpDir, fetch: fetchImpl },
    );
    await dq.findTables('x');

    expect(scopes).toEqual([`${MCP_RESOURCE}/.default`]);
    expect(dq.target).toEqual({
      tenantId: 't1',
      environment: 'Dev',
      company: 'CRONUS USA, Inc.',
      configurationName: 'cfg',
    });
    expect(mcp.seen[0]?.headers.authorization).toBe('Bearer mcp-tok');
  });

  it('refuses to guess a company', async () => {
    await new ProfileStore(tmpDir).upsertWithCredential(
      { name: 'nocompany', tenantId: 't1', environment: 'Dev' },
      { name: 'me', type: 'azureCli' },
    );
    await expect(
      createDataQueryClientForSelector({ profile: 'nocompany' }, { configDir: tmpDir }),
    ).rejects.toThrow(/none was given/);
  });
});

describe('getTableRelations', () => {
  it('maps both directions onto the far table, as BC names it per direction', async () => {
    const via = [{ fieldNo: 3, fieldName: 'Customer No.' }];
    const mcp = fakeMcp((_name, args) =>
      text(
        JSON.stringify(
          args.direction === 'outgoing'
            ? {
                tableId: 21,
                tableName: 'Cust. Ledger Entry',
                outgoing: [{ targetTableId: 18, targetTableName: 'Customer', viaFields: via }],
              }
            : {
                tableId: 18,
                tableName: 'Customer',
                incoming: [
                  {
                    referencingTableId: 21,
                    referencingTableName: 'Cust. Ledger Entry',
                    viaFields: via,
                  },
                ],
              },
        ),
      ),
    );
    const dq = client(mcp.fetchImpl);
    expect((await dq.getTableRelations(21)).relations).toEqual([
      { tableId: 18, tableName: 'Customer', viaFields: via },
    ]);
    expect((await dq.getTableRelations(18, { direction: 'incoming' })).relations).toEqual([
      { tableId: 21, tableName: 'Cust. Ledger Entry', viaFields: via },
    ]);
  });
});
