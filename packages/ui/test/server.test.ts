import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startUiServer, type UiServer } from '../src/index.js';
import { isExpectedHost, loopbackOrigin, parseRequestUrl } from '../src/server.js';

const EDMX = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Microsoft.NAV" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="customer">
        <Key><PropertyRef Name="id" /></Key>
        <Property Name="id" Type="Edm.Guid" Nullable="false" />
        <Property Name="number" Type="Edm.String" MaxLength="20" />
        <Property Name="displayName" Type="Edm.String" MaxLength="100" />
        <NavigationProperty Name="currency" Type="Microsoft.NAV.currency" />
      </EntityType>
      <EntityContainer Name="NAV">
        <EntitySet Name="customers" EntityType="Microsoft.NAV.customer" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

let configDir: string;
let servers: UiServer[];
let savedBackend: string | undefined;
let savedAuthority: string | undefined;

beforeEach(async () => {
  configDir = await mkdtemp(path.join(os.tmpdir(), 'navapi-ui-'));
  servers = [];
  savedBackend = process.env.NAVAPI_SECRET_BACKEND;
  savedAuthority = process.env.NAVAPI_AUTHORITY;
  process.env.NAVAPI_SECRET_BACKEND = 'file';
  process.env.NAVAPI_AUTHORITY = 'https://login.test';
});

afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()));
  await rm(configDir, { recursive: true, force: true });
  if (savedBackend === undefined) delete process.env.NAVAPI_SECRET_BACKEND;
  else process.env.NAVAPI_SECRET_BACKEND = savedBackend;
  if (savedAuthority === undefined) delete process.env.NAVAPI_AUTHORITY;
  else process.env.NAVAPI_AUTHORITY = savedAuthority;
});

async function start(options: Parameters<typeof startUiServer>[0] = {}): Promise<UiServer> {
  const server = await startUiServer({ configDir, open: false, ...options });
  if (!server.alreadyRunning) servers.push(server);
  return server;
}

function request(server: UiServer, pathname: string, init: RequestInit = {}): Promise<Response> {
  const origin = `http://127.0.0.1:${server.port}`;
  return fetch(`${origin}${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${server.token}`,
      ...(init.method && init.method !== 'GET' ? { origin } : {}),
      ...init.headers,
    },
  });
}

describe('UI server security and lifecycle', () => {
  it('accepts an omitted default port only when the server uses port 80', () => {
    expect(isExpectedHost('127.0.0.1', 80)).toBe(true);
    expect(isExpectedHost('127.0.0.1:80', 80)).toBe(true);
    expect(isExpectedHost('127.0.0.1', 8080)).toBe(false);
    expect(isExpectedHost('127.0.0.1:8080', 8080)).toBe(true);
    expect(isExpectedHost('localhost:8080', 8080)).toBe(false);
    expect(isExpectedHost('127.0.0.1@attacker.example', 80)).toBe(false);
    expect(loopbackOrigin(80)).toBe('http://127.0.0.1');
    expect(loopbackOrigin(8080)).toBe('http://127.0.0.1:8080');
  });

  it('rejects malformed request URLs without throwing from the server handler', () => {
    expect(parseRequestUrl('/api/state', 'http://127.0.0.1:8080')?.pathname).toBe('/api/state');
    expect(parseRequestUrl('http://[', 'http://127.0.0.1:8080')).toBeUndefined();
  });

  it('keeps the bearer token out of HTML and requires it for API requests', async () => {
    const server = await start();
    const rootResponse = await fetch(`http://127.0.0.1:${server.port}/`);
    const html = await rootResponse.text();

    expect(html).toContain('Business Central APIs');
    expect(html).toContain('/assets/codicon.css');
    expect(html).toContain('@media (prefers-color-scheme: dark)');
    expect(html).toContain('color-scheme:light');
    expect(html).toContain('color-scheme:dark');
    expect(html).not.toContain(server.token);
    expect(rootResponse.headers.get('content-security-policy')).toContain("font-src 'self'");
    expect(rootResponse.headers.get('content-security-policy')).toContain("style-src 'self'");
    const codiconCss = await fetch(`http://127.0.0.1:${server.port}/assets/codicon.css`);
    expect(codiconCss.headers.get('content-type')).toContain('text/css');
    expect(await codiconCss.text()).toContain('.codicon-symbol-class:before');
    expect(
      await fetch(`http://127.0.0.1:${server.port}/assets/codicon.ttf`).then((response) =>
        response.headers.get('content-type'),
      ),
    ).toBe('font/ttf');
    expect(
      await fetch(`http://127.0.0.1:${server.port}/api/state`).then((response) => response.status),
    ).toBe(401);
    expect((await request(server, '/api/state')).status).toBe(200);
  });

  it('rejects missing and cross-origin origins on authenticated writes', async () => {
    const server = await start();
    const url = `http://127.0.0.1:${server.port}/api/heartbeat`;
    const headers = { authorization: `Bearer ${server.token}` };

    expect(await fetch(url, { method: 'POST', headers }).then((response) => response.status)).toBe(
      403,
    );
    expect(
      await fetch(url, {
        method: 'POST',
        headers: { ...headers, origin: 'https://attacker.example' },
      }).then((response) => response.status),
    ).toBe(403);
  });

  it('rejects oversized bodies before parsing them', async () => {
    const server = await start();
    const response = await request(server, '/api/profiles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(129 * 1024) }),
    });
    expect(response.status).toBe(413);
  });

  it('reuses a live instance and removes the instance record on close', async () => {
    const first = await start();
    const second = await startUiServer({ configDir, open: false, profile: 'requested-profile' });

    expect(second.alreadyRunning).toBe(true);
    expect(second.port).toBe(first.port);
    expect(second.token).toBe(first.token);
    expect(second.url).toContain('?profile=requested-profile#');

    await first.close();
    await expect(readFile(path.join(configDir, 'ui-instance.json'), 'utf8')).rejects.toThrow();
  });

  it('serializes concurrent launches so only one server owns the instance', async () => {
    const [first, second] = await Promise.all([start(), start()]);
    const owners = [first, second].filter((server) => !server.alreadyRunning);

    expect(owners).toHaveLength(1);
    expect(first.port).toBe(second.port);
    expect(first.token).toBe(second.token);
  });

  it('does not delete an instance record that belongs to a different token', async () => {
    const server = await start();
    const instanceFile = path.join(configDir, 'ui-instance.json');
    const replacement = { pid: process.pid, port: server.port, token: 'replacement-token' };
    await writeFile(instanceFile, JSON.stringify(replacement), 'utf8');

    await server.close();

    await expect(readFile(instanceFile, 'utf8')).resolves.toContain('replacement-token');
  });

  it('rejects a conflicting explicit port instead of silently reusing it', async () => {
    const first = await start();
    const requestedPort = first.port === 65_535 ? 65_534 : first.port + 1;

    await expect(startUiServer({ configDir, open: false, port: requestedPort })).rejects.toThrow(
      `already running on port ${first.port}`,
    );
  });

  it('cleans up when the browser cannot be opened', async () => {
    await expect(
      startUiServer({
        configDir,
        openBrowser: async () => {
          throw new Error('browser unavailable');
        },
      }),
    ).rejects.toThrow('browser unavailable');
    await expect(readFile(path.join(configDir, 'ui-instance.json'), 'utf8')).rejects.toThrow();
  });

  it('shuts down after the startup grace and heartbeat idle timeout', async () => {
    const server = await start({ startupGraceMs: 0, idleTimeoutMs: 30 });
    await expect(server.closed).resolves.toBeUndefined();
  });
});

describe('UI API flows', () => {
  it('keeps a read-only profile read-only when saved from the web form', async () => {
    await writeFile(
      path.join(configDir, 'profiles.json'),
      JSON.stringify({
        profiles: {
          ro: {
            name: 'ro',
            tenantId: 'tenant',
            environment: 'Sandbox',
            auth: { type: 'clientSecret', clientId: 'client' },
            readOnly: true,
          },
        },
        defaultProfile: 'ro',
      }),
      'utf8',
    );
    const server = await start();

    const save = await request(server, '/api/profiles', {
      method: 'POST',
      body: JSON.stringify({
        profile: {
          name: 'ro',
          tenantId: 'tenant',
          clientId: 'client',
          clientSecret: 'secret',
          environment: 'Sandbox',
          company: 'CRONUS',
        },
        originalName: 'ro',
      }),
      headers: { 'content-type': 'application/json' },
    });
    expect(save.status).toBe(200);

    const after = JSON.parse(await readFile(path.join(configDir, 'profiles.json'), 'utf8'));
    expect(after.profiles.ro.readOnly).toBe(true);
    expect(after.profiles.ro.company).toBe('CRONUS');
  });

  it('refuses to rewrite an Azure CLI profile as a client-secret one', async () => {
    await writeFile(
      path.join(configDir, 'profiles.json'),
      JSON.stringify({
        profiles: {
          az: {
            name: 'az',
            tenantId: 'tenant',
            environment: 'Sandbox',
            auth: { type: 'azureCli' },
          },
        },
        defaultProfile: 'az',
      }),
      'utf8',
    );
    const server = await start();

    const listed = await request(server, '/api/state').then((response) => response.json());
    expect(listed.profiles[0]).toMatchObject({ name: 'az' });
    expect(listed.profiles[0].clientId).toBeUndefined();

    const save = await request(server, '/api/profiles', {
      method: 'POST',
      body: JSON.stringify({
        profile: {
          name: 'az',
          tenantId: 'tenant',
          clientId: 'client',
          clientSecret: 'secret',
          environment: 'Sandbox',
        },
      }),
      headers: { 'content-type': 'application/json' },
    });
    expect(save.status).toBe(400);
    expect((await save.json()).error).toMatch(/Azure CLI/);

    // the stored profile is untouched
    const after = JSON.parse(await readFile(path.join(configDir, 'profiles.json'), 'utf8'));
    expect(after.profiles.az.auth).toEqual({ type: 'azureCli' });
  });

  it('shares profiles and performs discovery, queries, paging, and navigation through core', async () => {
    const seen: string[] = [];
    const bcFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seen.push(url);
      if (url.includes('/oauth2/v2.0/token')) {
        return Response.json({ access_token: 'token', expires_in: 3600 });
      }
      if (url.endsWith('/v2.0/companies')) {
        return Response.json({
          value: [
            {
              id: '00000000-0000-0000-0000-000000000001',
              name: 'CRONUS',
              displayName: 'CRONUS International Ltd.',
            },
          ],
        });
      }
      if (url.includes('/microsoft/runtime/beta/companies(') && url.endsWith('/apiRoutes')) {
        return Response.json({ value: [{ route: 'v2.0' }] });
      }
      if (url.endsWith('/v2.0/$metadata')) {
        return new Response(EDMX, { headers: { 'content-type': 'application/xml' } });
      }
      if (url.includes('/customers') && url.includes('$skip=2')) {
        return Response.json({
          value: [{ id: '00000000-0000-0000-0000-000000000012', number: '30000' }],
        });
      }
      if (url.includes('/customers') && url.includes('$skip=1')) {
        return Response.json({
          value: [{ id: '00000000-0000-0000-0000-000000000011', number: '20000' }],
        });
      }
      if (url.includes('/customers(') && url.endsWith('/currency')) {
        return Response.json({ id: 'currency-1', code: 'USD' });
      }
      if (url.includes('/customers')) {
        expect(new Headers(init?.headers).get('prefer')).toBe('odata.maxpagesize=50');
        return Response.json({
          '@odata.count': 3,
          value: [
            {
              id: '00000000-0000-0000-0000-000000000010',
              number: '10000',
              displayName: '<img src=x onerror=alert(1)>',
            },
          ],
        });
      }
      return new Response('not found', { status: 404 });
    });
    const server = await start({ fetch: bcFetch as typeof fetch });

    const save = await request(server, '/api/profiles', {
      method: 'POST',
      body: JSON.stringify({
        profile: {
          name: 'demo',
          tenantId: 'tenant',
          clientId: 'client',
          clientSecret: 'secret',
          environment: 'Sandbox',
          company: 'CRONUS',
          baseUrl: 'https://bc.test',
        },
      }),
      headers: { 'content-type': 'application/json' },
    });
    expect(save.status).toBe(200);

    const companies = await request(server, '/api/companies?profile=demo').then((response) =>
      response.json(),
    );
    expect(companies.companies[0]).toMatchObject({
      label: 'CRONUS International Ltd.',
      isDefault: true,
    });

    const selectCompany = await request(server, '/api/profiles/demo/company', {
      method: 'POST',
      body: JSON.stringify({ company: '00000000-0000-0000-0000-000000000001' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(selectCompany.status).toBe(200);
    const state = await request(server, '/api/state').then((response) => response.json());
    expect(state.profiles[0].company).toBe('CRONUS International Ltd.');

    const discovery = await request(server, '/api/discovery?profile=demo&refresh=true').then(
      (response) => response.json(),
    );
    expect(discovery.routes[0].metadata.entitySets[0].name).toBe('customers');

    const query = await request(server, '/api/query', {
      method: 'POST',
      body: JSON.stringify({
        profile: 'demo',
        route: 'v2.0',
        entity: 'customers',
        filterRows: [{ field: 'number', type: 'Edm.String', op: 'eq', value: '10000' }],
        select: ['number', 'displayName'],
        orderby: { field: 'number', dir: 'asc' },
      }),
      headers: { 'content-type': 'application/json' },
    }).then((response) => response.json());
    expect(query.records[0].displayName).toContain('<img');
    expect(query.grid.rows[0][1].text).toContain('<img');
    expect(query.cursor).toBeTypeOf('string');
    expect(query.queryUrl).toContain("$filter=number%20eq%20'10000'");

    const manualQuery = await request(server, '/api/query', {
      method: 'POST',
      body: JSON.stringify({
        profile: 'demo',
        route: 'v2.0',
        entity: 'customers',
        manualFilter: true,
        filter: "startswith(displayName,'A')",
      }),
      headers: { 'content-type': 'application/json' },
    }).then((response) => response.json());
    expect(manualQuery.queryUrl).toContain("startswith(displayName%2C'A')");

    const next = await request(server, '/api/next', {
      method: 'POST',
      body: JSON.stringify({ cursor: query.cursor }),
      headers: { 'content-type': 'application/json' },
    }).then((response) => response.json());
    expect(next.combinedGrid.rows).toHaveLength(2);
    expect(next.cursor).toBeTypeOf('string');
    expect(
      await request(server, '/api/next', {
        method: 'POST',
        body: JSON.stringify({ cursor: query.cursor }),
        headers: { 'content-type': 'application/json' },
      }).then((response) => response.status),
    ).toBe(410);

    const last = await request(server, '/api/next', {
      method: 'POST',
      body: JSON.stringify({ cursor: next.cursor }),
      headers: { 'content-type': 'application/json' },
    }).then((response) => response.json());
    expect(last.combinedGrid.rows).toHaveLength(3);
    expect(last.cursor).toBeUndefined();
    expect(
      await request(server, '/api/next', {
        method: 'POST',
        body: JSON.stringify({ cursor: next.cursor }),
        headers: { 'content-type': 'application/json' },
      }).then((response) => response.status),
    ).toBe(410);

    const navigation = await request(server, '/api/navigation', {
      method: 'POST',
      body: JSON.stringify({
        profile: 'demo',
        route: 'v2.0',
        entity: 'customers',
        id: '00000000-0000-0000-0000-000000000010',
        nav: 'currency',
      }),
      headers: { 'content-type': 'application/json' },
    }).then((response) => response.json());
    expect(navigation).toMatchObject({ kind: 'record', records: [{ code: 'USD' }] });
    expect(seen.some((url) => url.endsWith('/v2.0/$metadata'))).toBe(true);
  });
});
