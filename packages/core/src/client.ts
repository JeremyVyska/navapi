import type { TokenProvider } from './auth.js';
import type { BatchRequest, BatchResponse } from './batch.js';
import { MetadataCache } from './cache.js';
import { NavApiError, NotFoundError, PreconditionFailedError } from './errors.js';
import { BcHttp } from './http.js';
import { parseMetadata } from './metadata.js';
import { buildQueryString, formatKey, isGuid, type ODataQuery } from './query.js';
import { parseRoutesResponse } from './routes.js';
import type {
  ApiRoute,
  BcRecord,
  CachedRouteMetadata,
  ProfileConfig,
  RouteDiscoveryResult,
} from './types.js';

export const DEFAULT_BASE_URL = 'https://api.businesscentral.dynamics.com';
export const STANDARD_ROUTE = 'v2.0';

export interface BcClientOptions {
  profile: ProfileConfig;
  auth: TokenProvider;
  fetch?: typeof globalThis.fetch;
  cache?: MetadataCache;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RecordOptions {
  /** API route path, e.g. `v2.0` or `contoso/fieldops/v1.0`. Default `v2.0`. */
  route?: string;
  /** Company name/displayName/GUID; falls back to the profile's company. */
  company?: string;
}

export interface ListOptions extends RecordOptions {
  query?: ODataQuery;
  /** Follow @odata.nextLink until exhausted. */
  all?: boolean;
  /**
   * Server-driven page size (`Prefer: odata.maxpagesize=N`). Unlike `$top`,
   * this yields an @odata.nextLink when more records exist — use it for
   * paged browsing; use `$top` only for a hard result cap.
   */
  maxPageSize?: number;
}

export interface ListResult {
  items: BcRecord[];
  /** Present when more pages exist and `all` was not set. */
  nextLink?: string;
  /** Total matching records — present when the query asked for `count`. */
  count?: number;
}

/** Entity sets addressed directly under the route rather than under a company. */
const COMPANY_UNSCOPED = new Set(['companies', 'subscriptions']);

/**
 * Display label for a company: first non-empty of displayName/name/id.
 * BC frequently returns present-but-empty strings, so `??` is not enough.
 */
export function companyLabel(company: Record<string, unknown>): string {
  for (const key of ['displayName', 'name', 'id']) {
    const value = company[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '(unnamed)';
}

/** Matches a company by GUID, name, or displayName (case-insensitive). */
export function findCompany(companies: BcRecord[], target: string): BcRecord | undefined {
  const wanted = target.toLowerCase();
  return companies.find(
    (c) =>
      String(c.id ?? '').toLowerCase() === wanted ||
      String(c.name ?? '').toLowerCase() === wanted ||
      String(c.displayName ?? '').toLowerCase() === wanted,
  );
}

/**
 * High-level Business Central client for one environment: route discovery,
 * $metadata ingestion, and company-scoped CRUD with transparent ETags.
 */
export class BcClient {
  readonly profile: ProfileConfig;
  readonly apiRoot: string;
  private readonly http: BcHttp;
  private readonly cache: MetadataCache;
  private readonly companyIds = new Map<string, string>();

  constructor(options: BcClientOptions) {
    this.profile = options.profile;
    const base = (options.profile.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.apiRoot = `${base}/v2.0/${options.profile.tenantId}/${encodeURIComponent(
      options.profile.environment,
    )}/api`;
    this.http = new BcHttp({
      auth: options.auth,
      fetch: options.fetch,
      maxRetries: options.maxRetries,
      sleep: options.sleep,
    });
    this.cache = options.cache ?? new MetadataCache();
  }

  // ---------------------------------------------------------------- routes

  /**
   * Lists every API route the environment exposes (standard, Microsoft,
   * custom). Preferred source is the documented runtime API:
   * `api/microsoft/runtime/<ver>/companies(<id>)/apiRoutes`; environments or
   * setups where that is unavailable fall back to the bare `api/routes`
   * probe, and finally to the standard v2.0 route which always exists.
   */
  async listRoutes(): Promise<ApiRoute[]> {
    const fromRuntime = await this.routesFromRuntimeApi();
    if (fromRuntime.length) return fromRuntime;
    try {
      const { data } = await this.http.request('GET', `${this.apiRoot}/routes`);
      const routes = parseRoutesResponse(data);
      return routes.length ? routes : [{ path: STANDARD_ROUTE, version: STANDARD_ROUTE }];
    } catch (err) {
      if (err instanceof NotFoundError) {
        return [{ path: STANDARD_ROUTE, version: STANDARD_ROUTE }];
      }
      throw err;
    }
  }

  private async routesFromRuntimeApi(): Promise<ApiRoute[]> {
    // apiRoutes is company-scoped; without a resolvable company, skip ahead.
    const companyId = await this.resolveCompanyId().catch(() => undefined);
    if (!companyId) return [];
    for (const runtime of ['microsoft/runtime/beta', 'microsoft/runtime/v1.0']) {
      try {
        const url = `${this.apiRoot}/${runtime}/companies(${companyId})/apiRoutes`;
        const { data } = await this.http.request('GET', url);
        const routes = parseRoutesResponse(data);
        if (routes.length) return routes;
      } catch {
        // runtime API missing or blocked here — try the next source
      }
    }
    return [];
  }

  // ------------------------------------------------------------- discovery

  /** Fetches (or reuses cached) parsed $metadata for one route. */
  async getMetadata(
    routePath: string,
    opts: { refresh?: boolean } = {},
  ): Promise<CachedRouteMetadata> {
    if (!opts.refresh) {
      const cached = await this.cache.get(this.profile.name, routePath);
      if (cached) return cached;
    }
    const { text } = await this.http.request('GET', `${this.apiRoot}/${routePath}/$metadata`, {
      headers: { accept: 'application/xml' },
    });
    const metadata = parseMetadata(text);
    return this.cache.set(this.profile.name, routePath, metadata);
  }

  /**
   * The auto-ingest pass: enumerate every route, pull and parse its
   * $metadata, and cache each one. Per-route failures are reported, not fatal.
   */
  async discoverAll(opts: { refresh?: boolean } = {}): Promise<RouteDiscoveryResult[]> {
    const routes = await this.listRoutes();
    return Promise.all(
      routes.map(async (route): Promise<RouteDiscoveryResult> => {
        try {
          return { route, metadata: await this.getMetadata(route.path, opts) };
        } catch (err) {
          return { route, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
  }

  /** The cached collection tree (route → entity sets) without hitting the network. */
  async cachedMetadata(): Promise<CachedRouteMetadata[]> {
    return this.cache.list(this.profile.name);
  }

  // ------------------------------------------------------------- companies

  async listCompanies(route: string = STANDARD_ROUTE): Promise<BcRecord[]> {
    const { items } = await this.list('companies', { route, all: true });
    return items;
  }

  /** Resolves a company name/displayName/GUID to its GUID, with caching. */
  async resolveCompanyId(company?: string): Promise<string> {
    const target = company ?? this.profile.company;
    if (!target) {
      throw new NavApiError(
        'No company specified. Pass one per call or set a default on the profile.',
      );
    }
    if (isGuid(target)) return target;
    const cached = this.companyIds.get(target.toLowerCase());
    if (cached) return cached;
    const companies = await this.listCompanies();
    const match = findCompany(companies, target);
    if (!match || typeof match.id !== 'string') {
      const known = companies.map((c) => c.name ?? c.displayName).join(', ');
      throw new NavApiError(`Company "${target}" not found. Available: ${known}`);
    }
    this.companyIds.set(target.toLowerCase(), match.id);
    return match.id;
  }

  private async collectionUrl(entitySet: string, opts: RecordOptions): Promise<string> {
    const route = opts.route ?? STANDARD_ROUTE;
    if (COMPANY_UNSCOPED.has(entitySet)) {
      return `${this.apiRoot}/${route}/${entitySet}`;
    }
    const companyId = await this.resolveCompanyId(opts.company);
    return `${this.apiRoot}/${route}/companies(${companyId})/${entitySet}`;
  }

  // ------------------------------------------------------------------ CRUD

  /** The exact URL a {@link list} call issues — for display, sharing, debugging. */
  async buildListUrl(entitySet: string, opts: ListOptions = {}): Promise<string> {
    return (await this.collectionUrl(entitySet, opts)) + buildQueryString(opts.query);
  }

  async list(entitySet: string, opts: ListOptions = {}): Promise<ListResult> {
    let url: string | undefined = await this.buildListUrl(entitySet, opts);
    const headers = opts.maxPageSize
      ? { prefer: `odata.maxpagesize=${opts.maxPageSize}` }
      : undefined;
    const items: BcRecord[] = [];
    let nextLink: string | undefined;
    let count: number | undefined;
    while (url) {
      const { data } = await this.http.request('GET', url, { headers });
      const page = data as {
        value?: BcRecord[];
        '@odata.nextLink'?: string;
        '@odata.count'?: number;
      };
      items.push(...(page.value ?? []));
      nextLink = page['@odata.nextLink'];
      count ??= page['@odata.count'];
      url = opts.all ? nextLink : undefined;
    }
    return { items, nextLink: opts.all ? undefined : nextLink, count };
  }

  /**
   * Fetches a navigation property of one record, e.g.
   * `getNavigation('salesOrders', id, 'salesOrderLines')`. Collection-valued
   * navigations return every item; single-valued ones return one item.
   */
  async getNavigation(
    entitySet: string,
    id: string,
    navProperty: string,
    opts: RecordOptions = {},
  ): Promise<{ kind: 'collection' | 'record'; items: BcRecord[] }> {
    const url = `${await this.collectionUrl(entitySet, opts)}(${formatKey(id)})/${navProperty}`;
    const { data } = await this.http.request('GET', url);
    const body = data as { value?: BcRecord[] } | BcRecord | null | undefined;
    if (body && Array.isArray((body as { value?: BcRecord[] }).value)) {
      return { kind: 'collection', items: (body as { value: BcRecord[] }).value };
    }
    return { kind: 'record', items: body ? [body as BcRecord] : [] };
  }

  /** Continues a paged list from a previous result's `nextLink`. */
  async followNextLink(nextLink: string, opts: { maxPageSize?: number } = {}): Promise<ListResult> {
    const headers = opts.maxPageSize
      ? { prefer: `odata.maxpagesize=${opts.maxPageSize}` }
      : undefined;
    const { data } = await this.http.request('GET', nextLink, { headers });
    const page = data as { value?: BcRecord[]; '@odata.nextLink'?: string };
    return { items: page.value ?? [], nextLink: page['@odata.nextLink'] };
  }

  async getRecord(entitySet: string, id: string, opts: RecordOptions = {}): Promise<BcRecord> {
    const url = `${await this.collectionUrl(entitySet, opts)}(${formatKey(id)})`;
    const { data } = await this.http.request('GET', url);
    return data as BcRecord;
  }

  async create(
    entitySet: string,
    body: unknown,
    opts: RecordOptions & { etag?: string } = {},
  ): Promise<BcRecord> {
    const url = await this.collectionUrl(entitySet, opts);
    const { data } = await this.http.request('POST', url, { body, ifMatch: opts.etag });
    return data as BcRecord;
  }

  /**
   * PATCH with transparent concurrency control: fetches the current ETag when
   * none is supplied, sends If-Match, and on a 412 refreshes the ETag and
   * retries exactly once before surfacing the conflict.
   */
  async update(
    entitySet: string,
    id: string,
    patch: unknown,
    opts: RecordOptions & { etag?: string } = {},
  ): Promise<BcRecord> {
    const url = `${await this.collectionUrl(entitySet, opts)}(${formatKey(id)})`;
    let etag = opts.etag ?? (await this.fetchEtag(url));
    try {
      const { data } = await this.http.request('PATCH', url, { body: patch, ifMatch: etag });
      return data as BcRecord;
    } catch (err) {
      if (!(err instanceof PreconditionFailedError)) throw err;
      etag = await this.fetchEtag(url);
      const { data } = await this.http.request('PATCH', url, { body: patch, ifMatch: etag });
      return data as BcRecord;
    }
  }

  /** DELETE with the same ETag handling as {@link update}. */
  async deleteRecord(
    entitySet: string,
    id: string,
    opts: RecordOptions & { etag?: string } = {},
  ): Promise<void> {
    const url = `${await this.collectionUrl(entitySet, opts)}(${formatKey(id)})`;
    let etag = opts.etag ?? (await this.fetchEtag(url));
    try {
      await this.http.request('DELETE', url, { ifMatch: etag });
    } catch (err) {
      if (!(err instanceof PreconditionFailedError)) throw err;
      etag = await this.fetchEtag(url);
      await this.http.request('DELETE', url, { ifMatch: etag });
    }
  }

  // --------------------------------------------------------- bound actions

  /**
   * Invokes a bound action on a record, e.g.
   * `callAction('salesOrders', id, 'shipAndInvoice')`. Unqualified action
   * names are prefixed with the route's schema namespace (from cached
   * metadata, falling back to `Microsoft.NAV`).
   */
  async callAction(
    entitySet: string,
    id: string,
    action: string,
    opts: RecordOptions & { parameters?: unknown } = {},
  ): Promise<BcRecord | undefined> {
    const qualified = await this.qualifyAction(action, opts.route);
    const url = `${await this.collectionUrl(entitySet, opts)}(${formatKey(id)})/${qualified}`;
    const { status, data } = await this.http.request('POST', url, {
      body: opts.parameters ?? undefined,
    });
    return status === 204 ? undefined : (data as BcRecord);
  }

  private async qualifyAction(action: string, route: string = STANDARD_ROUTE): Promise<string> {
    if (action.includes('.')) return action;
    const cached = await this.cache.get(this.profile.name, route);
    const namespace = cached?.metadata.namespace || 'Microsoft.NAV';
    return `${namespace}.${action}`;
  }

  // ----------------------------------------------------------------- batch

  /**
   * Executes an OData JSON batch. Request URLs are relative to the route
   * root; the `{company}` token resolves to the company GUID. Responses come
   * back in request order with `ok` precomputed — sub-request failures do
   * not throw, so bulk operations can report partial success.
   */
  async batch(requests: BatchRequest[], opts: RecordOptions = {}): Promise<BatchResponse[]> {
    const route = opts.route ?? STANDARD_ROUTE;
    const needsCompany = requests.some((r) => r.url.includes('{company}'));
    const companyId = needsCompany ? await this.resolveCompanyId(opts.company) : undefined;

    const prepared = requests.map((r, i) => ({
      id: r.id ?? String(i + 1),
      method: r.method,
      url: companyId ? r.url.replaceAll('{company}', companyId) : r.url,
      ...(r.atomicityGroup ? { atomicityGroup: r.atomicityGroup } : {}),
      ...(r.dependsOn ? { dependsOn: r.dependsOn } : {}),
      headers: {
        ...(r.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...r.headers,
      },
      ...(r.body !== undefined ? { body: r.body } : {}),
    }));

    const { data } = await this.http.request('POST', `${this.apiRoot}/${route}/$batch`, {
      body: { requests: prepared },
    });
    const responses = (data as { responses?: BatchResponse[] })?.responses ?? [];
    const byId = new Map(responses.map((r) => [String(r.id), r]));
    return prepared.map((req) => {
      const res = byId.get(req.id);
      if (!res) return { id: req.id, status: 0, ok: false, body: { missing: true } };
      return { ...res, id: String(res.id), ok: res.status < 400 };
    });
  }

  private async fetchEtag(recordUrl: string): Promise<string> {
    const { data } = await this.http.request('GET', recordUrl);
    const etag = (data as BcRecord)['@odata.etag'];
    if (typeof etag !== 'string' || !etag) {
      throw new NavApiError(
        `Record at ${recordUrl} has no @odata.etag; cannot modify it safely. ` +
          'Pass an explicit etag ("*" to force) if you really want to.',
      );
    }
    return etag;
  }
}
