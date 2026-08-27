import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, open as openFile, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  BcClient,
  type BcRecord,
  ClientCredentialsAuth,
  companyLabel,
  createClientForProfile,
  defaultConfigDir,
  findCompany,
  MetadataCache,
  type ODataQuery,
  type ProfileConfig,
  ProfileStore,
  resolveSecretStore,
} from '@navapi/core';
import { renderAppHtml } from './app.js';
import { openDefaultBrowser } from './browser.js';
import { buildFilterExpression, buildGrid, type FilterRow, operatorsFor } from './shared.js';

const LOOPBACK = '127.0.0.1';
const MAX_BODY_BYTES = 128 * 1024;
const PAGE_SIZE = 50;
const DEFAULT_IDLE_TIMEOUT = 30_000;
const DEFAULT_STARTUP_GRACE = 60_000;
const INSTANCE_FILE = 'ui-instance.json';
const STARTUP_LOCK_FILE = 'ui-start.lock';
const { version: packageVersion } = createRequire(import.meta.url)('../package.json') as {
  version: string;
};

interface InstanceRecord {
  pid: number;
  port: number;
  token: string;
}

interface Cursor {
  profile: string;
  route: string;
  entity: string;
  query: ODataQuery;
  nextLink?: string;
  totalCount?: number;
  records: BcRecord[];
  expiresAt: number;
}

export interface UiServerOptions {
  profile?: string;
  configDir?: string;
  port?: number;
  open?: boolean;
  idleTimeoutMs?: number;
  startupGraceMs?: number;
  fetch?: typeof globalThis.fetch;
  openBrowser?: (url: string) => void | Promise<void>;
  version?: string;
}

export interface UiServer {
  url: string;
  port: number;
  token: string;
  alreadyRunning: boolean;
  closed: Promise<void>;
  close(): Promise<void>;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function secureHeaders(nonce?: string): Record<string, string> {
  return {
    'cache-control': 'no-store',
    'content-security-policy': nonce
      ? `default-src 'none'; connect-src 'self'; img-src 'self' data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
      : "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    ...secureHeaders(),
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new ApiError(413, 'Request body is too large.');
    chunks.push(bytes);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new ApiError(400, 'Request body must be a JSON object.');
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ApiError(400, `${name} is required.`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function profileFrom(value: unknown): ProfileConfig & { clientSecret?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, 'profile is required.');
  }
  const input = value as Record<string, unknown>;
  const baseUrl = optionalString(input.baseUrl);
  if (baseUrl) {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new ApiError(400, 'API base URL must be a valid URL.');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new ApiError(400, 'API base URL must use HTTP or HTTPS.');
    }
  }
  return {
    name: requiredString(input.name, 'Profile name'),
    tenantId: requiredString(input.tenantId, 'Tenant'),
    clientId: requiredString(input.clientId, 'Client ID'),
    environment: requiredString(input.environment, 'Environment'),
    company: optionalString(input.company),
    baseUrl,
    clientSecret: optionalString(input.clientSecret),
  };
}

async function writeInstance(file: string, record: InstanceRecord): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
  await chmod(file, 0o600).catch(() => undefined);
}

async function readInstance(file: string): Promise<InstanceRecord | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<InstanceRecord>;
    if (
      typeof parsed.pid === 'number' &&
      typeof parsed.port === 'number' &&
      typeof parsed.token === 'string'
    ) {
      return parsed as InstanceRecord;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function acquireStartupLock(file: string): Promise<() => Promise<void>> {
  await mkdir(path.dirname(file), { recursive: true });
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      const handle = await openFile(file, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await handle.close();
        await rm(file, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const info = await stat(file);
        if (Date.now() - info.mtimeMs > 30_000) {
          await rm(file, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for another navapi UI process to finish starting.');
      }
      await delay(50);
    }
  }
}

async function removeOwnInstance(file: string, token: string): Promise<void> {
  const current = await readInstance(file);
  if (current?.pid === process.pid && safeEqual(current.token, token)) {
    await rm(file, { force: true });
  }
}

async function liveInstance(
  record: InstanceRecord,
  fetchImpl: typeof globalThis.fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(`http://${LOOPBACK}:${record.port}/api/status`, {
      headers: { authorization: `Bearer ${record.token}` },
      signal: AbortSignal.timeout(750),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function launchUrl(port: number, token: string, profile?: string): string {
  const query = profile ? `?profile=${encodeURIComponent(profile)}` : '';
  return `http://${LOOPBACK}:${port}/${query}#${token}`;
}

export async function startUiServer(options: UiServerOptions = {}): Promise<UiServer> {
  const configDir = options.configDir ?? defaultConfigDir();
  const instanceFile = path.join(configDir, INSTANCE_FILE);
  const startupLockFile = path.join(configDir, STARTUP_LOCK_FILE);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const browser = options.openBrowser ?? openDefaultBrowser;
  const existing = await readInstance(instanceFile);
  if (existing && (await liveInstance(existing, globalThis.fetch))) {
    if (options.port !== undefined && options.port !== 0 && options.port !== existing.port) {
      throw new Error(
        `navapi UI is already running on port ${existing.port}; stop it before requesting port ${options.port}.`,
      );
    }
    const url = launchUrl(existing.port, existing.token, options.profile);
    if (options.open !== false) await browser(url);
    return {
      url,
      port: existing.port,
      token: existing.token,
      alreadyRunning: true,
      closed: Promise.resolve(),
      close: async () => undefined,
    };
  }
  const token = randomBytes(32).toString('base64url');
  const cursors = new Map<string, Cursor>();
  const profileStore = new ProfileStore(configDir);
  const secret = await resolveSecretStore(configDir);
  let preferredProfile = options.profile;
  let lastHeartbeat = Date.now();
  const startedAt = Date.now();
  let port = 0;
  let baseUrl = '';
  let closing = false;
  let idleTimer: NodeJS.Timeout | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const client = (profile?: string) =>
    createClientForProfile(profile ?? preferredProfile, { configDir, fetch: fetchImpl });

  async function entity(profile: string, route: string, name: string) {
    const metadata = await (await client(profile)).getMetadata(route);
    const found = metadata.metadata.entitySets.find((item) => item.name === name);
    if (!found) throw new ApiError(404, `Entity set "${name}" was not found on route "${route}".`);
    return found;
  }

  async function close(): Promise<void> {
    if (closing) return closed;
    closing = true;
    if (idleTimer) clearInterval(idleTimer);
    for (const cursor of cursors.keys()) cursors.delete(cursor);
    await removeOwnInstance(instanceFile, token).catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    resolveClosed();
  }

  async function handleApi(
    request: IncomingMessage,
    response: ServerResponse,
    requestUrl: URL,
  ): Promise<void> {
    const method = request.method ?? 'GET';
    const pathname = requestUrl.pathname;
    if (method === 'GET' && pathname === '/api/status') {
      sendJson(response, 200, { ok: true, pid: process.pid });
      return;
    }
    if (method === 'POST' && pathname === '/api/heartbeat') {
      lastHeartbeat = Date.now();
      sendJson(response, 200, { ok: true });
      return;
    }
    if (method === 'POST' && pathname === '/api/quit') {
      sendJson(response, 200, { ok: true });
      setImmediate(() => void close());
      return;
    }
    if (method === 'GET' && pathname === '/api/state') {
      const { profiles, defaultProfile } = await profileStore.listAll();
      const withSecret = await Promise.all(
        profiles.map(async (profile) => ({
          ...profile,
          hasSecret: Boolean(await secret.store.get(profile.name)),
        })),
      );
      sendJson(response, 200, {
        profiles: withSecret,
        defaultProfile,
        preferredProfile,
        secretBackend: secret.backend,
      });
      return;
    }
    if (method === 'POST' && pathname === '/api/profiles/test') {
      const body = await readJson(request);
      const profile = profileFrom(body.profile);
      const originalName = optionalString(body.originalName);
      const clientSecret =
        profile.clientSecret ??
        (originalName ? await secret.store.get(originalName) : undefined) ??
        (await secret.store.get(profile.name));
      if (!clientSecret) throw new ApiError(400, 'A client secret is required.');
      const testClient = new BcClient({
        profile,
        auth: new ClientCredentialsAuth({
          tenantId: profile.tenantId,
          clientId: profile.clientId,
          clientSecret,
          authorityBase: process.env.NAVAPI_AUTHORITY,
          fetch: fetchImpl,
        }),
        fetch: fetchImpl,
      });
      const companies = await testClient.listCompanies();
      sendJson(response, 200, {
        companies: companies.map((company) => ({
          id: String(company.id ?? ''),
          name: String(company.name ?? ''),
          label: companyLabel(company),
        })),
      });
      return;
    }
    if (method === 'POST' && pathname === '/api/profiles') {
      const body = await readJson(request);
      const profile = profileFrom(body.profile);
      const originalName = optionalString(body.originalName);
      if (originalName && originalName !== profile.name) {
        throw new ApiError(400, 'Profile names cannot be changed.');
      }
      const { profiles } = await profileStore.listAll();
      const exists = profiles.some((item) => item.name === profile.name);
      if (!originalName && exists)
        throw new ApiError(409, `Profile "${profile.name}" already exists.`);
      const currentSecret = exists ? await secret.store.get(profile.name) : undefined;
      if (!profile.clientSecret && !currentSecret) {
        throw new ApiError(400, 'A client secret is required.');
      }
      await profileStore.upsert({
        name: profile.name,
        tenantId: profile.tenantId,
        clientId: profile.clientId,
        environment: profile.environment,
        company: profile.company,
        baseUrl: profile.baseUrl,
      });
      if (profile.clientSecret) await secret.store.set(profile.name, profile.clientSecret);
      preferredProfile = profile.name;
      sendJson(response, 200, { ok: true, name: profile.name, secretBackend: secret.backend });
      return;
    }

    const profileMatch = /^\/api\/profiles\/([^/]+)\/(default|company)$/.exec(pathname);
    if (method === 'POST' && profileMatch) {
      const name = decodeURIComponent(profileMatch[1] as string);
      await profileStore.get(name);
      if (profileMatch[2] === 'default') {
        await profileStore.setDefault(name);
        preferredProfile = name;
      } else {
        const body = await readJson(request);
        const company = requiredString(body.company, 'Company');
        const profile = await profileStore.get(name);
        await profileStore.upsert({ ...profile, company });
      }
      sendJson(response, 200, { ok: true });
      return;
    }

    const deleteMatch = /^\/api\/profiles\/([^/]+)$/.exec(pathname);
    if (method === 'DELETE' && deleteMatch) {
      const name = decodeURIComponent(deleteMatch[1] as string);
      await profileStore.remove(name);
      await secret.store.delete(name);
      await new MetadataCache(path.join(configDir, 'cache')).clear(name);
      if (preferredProfile === name) preferredProfile = undefined;
      sendJson(response, 200, { ok: true });
      return;
    }
    if (method === 'GET' && pathname === '/api/companies') {
      const profileName = requiredString(requestUrl.searchParams.get('profile'), 'Profile');
      const bc = await client(profileName);
      const profile = bc.profile;
      const companies = await bc.listCompanies();
      const current = profile.company ? findCompany(companies, profile.company) : undefined;
      sendJson(response, 200, {
        companies: companies.map((company) => ({
          id: String(company.id ?? ''),
          name: String(company.name ?? ''),
          label: companyLabel(company),
          isDefault: Boolean(current && current.id === company.id),
        })),
      });
      return;
    }
    if (method === 'GET' && pathname === '/api/discovery') {
      const profileName = requiredString(requestUrl.searchParams.get('profile'), 'Profile');
      const refresh = requestUrl.searchParams.get('refresh') === 'true';
      const bc = await client(profileName);
      let routes = refresh ? [] : await bc.cachedMetadata();
      const errors: { route: string; error: string }[] = [];
      if (!routes.length || refresh) {
        const results = await bc.discoverAll({ refresh });
        routes = results.flatMap((result) => (result.metadata ? [result.metadata] : []));
        errors.push(
          ...results.flatMap((result) =>
            result.error ? [{ route: result.route.path, error: result.error }] : [],
          ),
        );
      }
      sendJson(response, 200, {
        routes,
        errors,
        warning: bc.profile.company
          ? undefined
          : 'Select a default company to discover Microsoft and custom API routes.',
      });
      return;
    }
    if (method === 'POST' && pathname === '/api/query') {
      const body = await readJson(request);
      const profileName = requiredString(body.profile, 'Profile');
      const route = requiredString(body.route, 'Route');
      const entityName = requiredString(body.entity, 'Entity');
      const schema = await entity(profileName, route, entityName);
      const rows = Array.isArray(body.filterRows) ? (body.filterRows as FilterRow[]) : [];
      const knownFields = new Map(schema.properties.map((field) => [field.name, field]));
      for (const row of rows) {
        const field = knownFields.get(row.field);
        if (!field || row.type !== field.type || !operatorsFor(field.type).includes(row.op)) {
          throw new ApiError(400, 'The query contains an invalid filter field or operator.');
        }
      }
      const select = Array.isArray(body.select)
        ? body.select.map((value) => requiredString(value, 'Selected field'))
        : [];
      if (select.some((field) => !knownFields.has(field))) {
        throw new ApiError(400, 'The query contains an unknown selected field.');
      }
      const orderInput =
        body.orderby && typeof body.orderby === 'object'
          ? (body.orderby as Record<string, unknown>)
          : undefined;
      const orderby = orderInput
        ? {
            field: requiredString(orderInput.field, 'Sort field'),
            dir: orderInput.dir === 'desc' ? ('desc' as const) : ('asc' as const),
          }
        : undefined;
      if (orderby && !knownFields.has(orderby.field)) {
        throw new ApiError(400, 'The query contains an unknown sort field.');
      }
      const keys = schema.keys.length ? schema.keys : ['id'];
      const effectiveSelect = select.length ? [...new Set([...keys, ...select])] : undefined;
      const filter = buildFilterExpression(rows, body.combinator === 'or' ? 'or' : 'and');
      const bc = await client(profileName);
      const query = {
        count: true,
        filter: filter || undefined,
        select: effectiveSelect,
        orderby: orderby ? [`${orderby.field} ${orderby.dir}`] : undefined,
      };
      const [result, queryUrl] = await Promise.all([
        bc.list(entityName, { route, maxPageSize: PAGE_SIZE, query }),
        bc.buildListUrl(entityName, { route, query }),
      ]);
      let cursor: string | undefined;
      if (
        result.nextLink ||
        (result.count !== undefined &&
          result.items.length > 0 &&
          result.items.length < result.count)
      ) {
        cursor = randomUUID();
        cursors.set(cursor, {
          profile: profileName,
          route,
          entity: entityName,
          query,
          nextLink: result.nextLink,
          totalCount: result.count,
          records: result.items,
          expiresAt: Date.now() + 30 * 60_000,
        });
      }
      sendJson(response, 200, {
        records: result.items,
        grid: buildGrid(result.items),
        cursor,
        totalCount: result.count,
        queryUrl,
        orderby,
      });
      return;
    }
    if (method === 'POST' && pathname === '/api/next') {
      const body = await readJson(request);
      const cursorId = requiredString(body.cursor, 'Cursor');
      const cursor = cursors.get(cursorId);
      cursors.delete(cursorId);
      if (!cursor || cursor.expiresAt < Date.now()) {
        throw new ApiError(410, 'This page cursor has expired. Run the query again.');
      }
      const bc = await client(cursor.profile);
      const result = cursor.nextLink
        ? await bc.followNextLink(cursor.nextLink, { maxPageSize: PAGE_SIZE })
        : await bc.list(cursor.entity, {
            route: cursor.route,
            maxPageSize: PAGE_SIZE,
            query: { ...cursor.query, count: undefined, skip: cursor.records.length },
          });
      const records = [...cursor.records, ...result.items];
      let nextCursor: string | undefined;
      if (
        result.nextLink ||
        (cursor.totalCount !== undefined &&
          result.items.length > 0 &&
          records.length < cursor.totalCount)
      ) {
        nextCursor = randomUUID();
        cursors.set(nextCursor, {
          ...cursor,
          nextLink: result.nextLink,
          records,
          expiresAt: Date.now() + 30 * 60_000,
        });
      }
      sendJson(response, 200, {
        records: result.items,
        grid: buildGrid(result.items),
        combinedGrid: buildGrid(records),
        cursor: nextCursor,
        totalCount: cursor.totalCount,
      });
      return;
    }
    if (method === 'POST' && pathname === '/api/navigation') {
      const body = await readJson(request);
      const profileName = requiredString(body.profile, 'Profile');
      const route = requiredString(body.route, 'Route');
      const entityName = requiredString(body.entity, 'Entity');
      const id = requiredString(body.id, 'Record ID');
      const nav = requiredString(body.nav, 'Navigation property');
      const schema = await entity(profileName, route, entityName);
      if (schema.keys.length > 1) {
        throw new ApiError(400, 'Navigation browsing does not support composite entity keys.');
      }
      if (!schema.navigationProperties.some((item) => item.name === nav)) {
        throw new ApiError(400, 'Unknown navigation property.');
      }
      const result = await (await client(profileName)).getNavigation(entityName, id, nav, {
        route,
      });
      sendJson(response, 200, { kind: result.kind, records: result.items });
      return;
    }
    throw new ApiError(404, 'Not found.');
  }

  const server = createServer((request, response) => {
    void (async () => {
      const host = request.headers.host ?? '';
      if (host !== `${LOOPBACK}:${port}`) {
        sendJson(response, 403, { error: 'Invalid host.' });
        return;
      }
      const requestUrl = new URL(request.url ?? '/', baseUrl);
      if (request.method === 'GET' && requestUrl.pathname === '/') {
        const nonce = randomBytes(18).toString('base64url');
        response.writeHead(200, {
          ...secureHeaders(nonce),
          'content-type': 'text/html; charset=utf-8',
        });
        response.end(renderAppHtml(nonce, options.version ?? packageVersion));
        return;
      }
      if (!requestUrl.pathname.startsWith('/api/')) {
        sendJson(response, 404, { error: 'Not found.' });
        return;
      }
      const authorization = request.headers.authorization ?? '';
      if (!safeEqual(authorization, `Bearer ${token}`)) {
        sendJson(response, 401, { error: 'Unauthorized.' });
        return;
      }
      const origin = request.headers.origin;
      if (origin && origin !== baseUrl) {
        sendJson(response, 403, { error: 'Invalid origin.' });
        return;
      }
      if (request.method !== 'GET' && origin !== baseUrl) {
        sendJson(response, 403, { error: 'Origin header is required.' });
        return;
      }
      try {
        await handleApi(request, response, requestUrl);
      } catch (error) {
        const status = error instanceof ApiError ? error.status : 500;
        sendJson(response, status, { error: errorMessage(error) });
      }
    })();
  });

  const releaseStartupLock = await acquireStartupLock(startupLockFile);
  try {
    const winner = await readInstance(instanceFile);
    if (winner && (await liveInstance(winner, globalThis.fetch))) {
      if (options.port !== undefined && options.port !== 0 && options.port !== winner.port) {
        throw new Error(
          `navapi UI is already running on port ${winner.port}; stop it before requesting port ${options.port}.`,
        );
      }
      const url = launchUrl(winner.port, winner.token, options.profile);
      if (options.open !== false) await browser(url);
      return {
        url,
        port: winner.port,
        token: winner.token,
        alreadyRunning: true,
        closed: Promise.resolve(),
        close: async () => undefined,
      };
    }
    if (winner) await rm(instanceFile, { force: true });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 0, LOOPBACK, () => {
        server.off('error', reject);
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Could not determine the navapi UI port.'));
          return;
        }
        port = address.port;
        baseUrl = `http://${LOOPBACK}:${port}`;
        resolve();
      });
    });
    try {
      await writeInstance(instanceFile, { pid: process.pid, port, token });
    } catch (error) {
      await close();
      throw error;
    }
  } finally {
    await releaseStartupLock();
  }

  const idleTimeout = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT;
  const startupGrace = options.startupGraceMs ?? DEFAULT_STARTUP_GRACE;
  idleTimer = setInterval(
    () => {
      const now = Date.now();
      for (const [id, cursor] of cursors) {
        if (cursor.expiresAt < now) cursors.delete(id);
      }
      if (now - startedAt >= startupGrace && now - lastHeartbeat >= idleTimeout) {
        void close();
      }
    },
    Math.min(5_000, Math.max(25, idleTimeout)),
  );
  idleTimer.unref();

  const url = launchUrl(port, token, options.profile);
  if (options.open !== false) {
    try {
      await browser(url);
    } catch (error) {
      await close();
      throw error;
    }
  }
  return { url, port, token, alreadyRunning: false, closed, close };
}
