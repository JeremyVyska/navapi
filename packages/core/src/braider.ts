import type { BcClient } from './client.js';
import { NavApiError } from './errors.js';
import type { BcRecord, RouteMetadata } from './types.js';

/**
 * First-class support for Data Braider (sparebrained/databraider), the no-code
 * API factory for Business Central. Braider tunnels everything interesting
 * through double-encoded JSON string fields (`jsonResult`, `filterJson`,
 * `jsonInput`); this module is the ONLY place that encoding is handled —
 * callers see plain parsed values.
 */

export const BRAIDER_PUBLISHER = 'sparebrained';
export const BRAIDER_GROUP = 'databraider';

export type BraiderWriteAction = 'Insert' | 'Update' | 'Delete' | 'Upsert';
export const BRAIDER_WRITE_ACTIONS: readonly BraiderWriteAction[] = [
  'Insert',
  'Update',
  'Delete',
  'Upsert',
];

/** One Braider filter: BC filter syntax, table/field by name or number. */
export interface BraiderFilter {
  table: string | number;
  field: string | number;
  filter: string;
}

/** An endpoint as reported by the read API auto-list / GET. */
export interface BraiderEndpoint {
  code: string;
  description: string;
  /** Decoded enum, e.g. `Read Only`, `Per Record`, `Batch`, `Delta Read`. */
  endpointType: string;
  /** Decoded enum: `Hierarchy` or `Flat`. */
  outputJsonType: string;
  pageStart?: number;
  pageSize?: number;
  topLevelRecordCount?: number;
  includedRecordCount?: number;
}

/** One node of a Hierarchy-format read result. */
export interface BraiderHierarchyNode {
  level: number;
  sourceTableNumber: number;
  sourceTableName: string;
  pkString: string;
  sourceSystemId: string;
  data: Record<string, unknown>;
  children?: BraiderHierarchyNode[];
}

export interface BraiderReadResult {
  /** Parsed rows: flat objects (`"Table.Field"` keys) or hierarchy nodes. */
  records: unknown[];
  /** Present when the endpoint has Emit Raw Diagnostic Data enabled. */
  diagnostics?: unknown;
  pageStart?: number;
  pageSize?: number;
  topLevelRecordCount?: number;
  includedRecordCount?: number;
  /** True when more top-level records exist beyond the returned page(s). */
  hasMore: boolean;
  /** The unparsed API row — only populated when `raw: true` was requested. */
  raw?: BcRecord;
}

export type BraiderWriteRecord = Record<string, unknown> & { Action?: BraiderWriteAction };

export interface BraiderWriteResultEntry {
  action: string;
  data?: unknown;
  gravestonePK?: string;
  [key: string]: unknown;
}

/** Entity sets of the config/authoring API (Data Braider 2.4+), when present. */
export interface BraiderConfigSets {
  configs?: string;
  lines?: string;
  fields?: string;
  relations?: string;
  schemas?: string;
  tables?: string;
  fieldsLookup?: string;
}

export interface BraiderInfo {
  /** Route path, e.g. `sparebrained/databraider/v2.0`. */
  routePath: string;
  version: string;
  /** `readwrite` = read/write only; `config` = authoring API also present. */
  level: 'readwrite' | 'config';
  entitySets: string[];
  configSets: BraiderConfigSets;
}

export interface BraiderSchemaProperty {
  name: string;
  type: string;
  required: boolean;
  tableNo?: number;
  fieldNo?: number;
  writeEnabled?: boolean;
  primaryKey?: boolean;
}

export interface BraiderEndpointSchema {
  code: string;
  /** `api` = live schema entity (Braider 2.4+); `inferred` = sampled from data. */
  source: 'api' | 'inferred';
  endpointType?: string;
  outputJsonType?: string;
  readSchema?: BraiderSchemaProperty[];
  writeSchema?: BraiderSchemaProperty[];
}

export interface BraiderFieldSpec {
  /** Field name (JSON-safe or fixed name, case-insensitive) or field number. */
  field: string | number;
  writeEnabled?: boolean;
  mandatory?: boolean;
  filter?: string;
  defaultValue?: string;
  upsertMatch?: boolean;
  manualFieldCaption?: string;
}

export interface BraiderLineSpec {
  /** Table number, or table name (resolved via availableTables). */
  sourceTable: number | string;
  indentation?: number;
  /** Fields to include; names, numbers, or full specs. */
  includeFields: (string | number | BraiderFieldSpec)[];
}

export interface BraiderEndpointSpec {
  code: string;
  description?: string;
  endpointType: 'Read Only' | 'Per Record' | 'Batch';
  outputJsonType?: 'Hierarchy' | 'Flat';
  enabled?: boolean;
  hideFromLists?: boolean;
  pageSize?: number;
  lines: BraiderLineSpec[];
}

// ---------------------------------------------------------------- helpers

const ODATA_NAME_ESCAPE = /_x([0-9A-Fa-f]{4})_/g;

/** Decodes EDM-encoded member names, e.g. `Per_x0020_Record` → `Per Record`. */
export function decodeODataName(value: string): string {
  return value.replace(ODATA_NAME_ESCAPE, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

/** Encodes spaces for EDM member names, e.g. `Per Record` → `Per_x0020_Record`. */
export function encodeODataName(value: string): string {
  return value.replaceAll(' ', '_x0020_');
}

function snippet(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
}

function isBraiderErrorEntry(value: unknown): value is { Error: boolean; Detail: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'Row' in value &&
    'Column' in value &&
    'Error' in value &&
    'Detail' in value
  );
}

/**
 * Parses a Braider `jsonResult` payload (a string containing JSON). Handles
 * the empty case, the `{data, diagnostics}` envelope, and Braider error blobs
 * (arrays of `{Row, Column, Error, Detail}` — surfaced as a NavApiError).
 */
export function parseJsonResult(raw: unknown): { records: unknown[]; diagnostics?: unknown } {
  if (raw === null || raw === undefined) return { records: [] };
  if (typeof raw !== 'string') {
    throw new NavApiError(`Expected jsonResult to be a string, got ${typeof raw}.`);
  }
  if (!raw.trim()) return { records: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new NavApiError(
      `Data Braider returned jsonResult that is not valid JSON: ${snippet(raw)}`,
    );
  }

  if (Array.isArray(parsed)) {
    if (parsed.length && parsed.every(isBraiderErrorEntry)) {
      const details = parsed.filter((e) => e.Error).map((e) => e.Detail);
      if (details.length) {
        throw new NavApiError(`Data Braider reported errors: ${details.join('; ')}`);
      }
    }
    return { records: parsed };
  }
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    Array.isArray((parsed as { data?: unknown[] }).data)
  ) {
    const envelope = parsed as { data: unknown[]; diagnostics?: unknown };
    return { records: envelope.data, diagnostics: envelope.diagnostics };
  }
  return { records: [parsed] };
}

/** Serializes filters for the `filterJson` request field (stringified array). */
export function encodeFilterJson(filters: BraiderFilter[]): string {
  return JSON.stringify(filters.map((f) => ({ table: f.table, field: f.field, filter: f.filter })));
}

/**
 * Serializes write records for the `jsonInput` request field, ensuring every
 * record carries a valid `Action` (filling in `defaultAction` when missing).
 */
export function encodeJsonInput(
  records: BraiderWriteRecord[],
  defaultAction?: BraiderWriteAction,
): string {
  const prepared = records.map((record, i) => {
    const action = record.Action ?? defaultAction;
    if (!action) {
      throw new NavApiError(
        `Write record ${i + 1} has no "Action" and no default action was given. ` +
          `Each record needs Action: ${BRAIDER_WRITE_ACTIONS.join(' | ')}.`,
      );
    }
    if (!BRAIDER_WRITE_ACTIONS.includes(action)) {
      throw new NavApiError(
        `Write record ${i + 1} has invalid Action "${action}". ` +
          `Valid actions: ${BRAIDER_WRITE_ACTIONS.join(' | ')}.`,
      );
    }
    return { ...record, Action: action };
  });
  return JSON.stringify(prepared);
}

function maybeNumber(value: string): string | number {
  return /^\d+$/.test(value) ? Number.parseInt(value, 10) : value;
}

/**
 * Parses the CLI-friendly filter DSL `Table.Field=bcfilter` into a
 * {@link BraiderFilter}. Splits at the FIRST `=` (BC filter expressions like
 * `10000..20000` or `<>''` never lead with `=`) and the FIRST `.` (table
 * names never contain dots; field names like `No.` do).
 */
export function parseBraiderFilterSpec(spec: string): BraiderFilter {
  const eq = spec.indexOf('=');
  if (eq <= 0) {
    throw new NavApiError(
      `Invalid filter "${spec}". Expected Table.Field=filter, e.g. "Customer.No.=10000..20000".`,
    );
  }
  const left = spec.slice(0, eq);
  const filter = spec.slice(eq + 1);
  const dot = left.indexOf('.');
  if (dot <= 0 || dot === left.length - 1) {
    throw new NavApiError(
      `Invalid filter "${spec}". The part before "=" must be Table.Field, e.g. "Customer.Name".`,
    );
  }
  if (!filter) {
    throw new NavApiError(`Invalid filter "${spec}". The filter expression after "=" is empty.`);
  }
  return {
    table: maybeNumber(left.slice(0, dot)),
    field: maybeNumber(left.slice(dot + 1)),
    filter,
  };
}

// -------------------------------------------------------------- detection

const CONFIG_SET_CANDIDATES: Record<keyof BraiderConfigSets, string> = {
  configs: 'endpointconfigs',
  lines: 'endpointlines',
  fields: 'endpointfields',
  relations: 'endpointrelations',
  schemas: 'endpointschemas',
  tables: 'availabletables',
  fieldsLookup: 'availablefields',
};

/**
 * Maps a Braider route's entity sets onto the config API surface. The exact
 * entity-set names live here and nowhere else, matched case-insensitively so
 * navapi tolerates casing drift between Braider versions.
 */
export function resolveConfigSets(metadata: RouteMetadata): BraiderConfigSets {
  const byLower = new Map(metadata.entitySets.map((s) => [s.name.toLowerCase(), s.name]));
  const sets: BraiderConfigSets = {};
  for (const [key, candidate] of Object.entries(CONFIG_SET_CANDIDATES)) {
    const actual = byLower.get(candidate);
    if (actual) sets[key as keyof BraiderConfigSets] = actual;
  }
  return sets;
}

function braiderVersionRank(version: string): number {
  const match = /^v?(\d+)(?:\.(\d+))?/.exec(version);
  if (!match) return -1;
  return Number.parseInt(match[1], 10) * 1000 + Number.parseInt(match[2] ?? '0', 10);
}

function isBraiderRoutePath(path: string): boolean {
  return path.toLowerCase().startsWith(`${BRAIDER_PUBLISHER}/${BRAIDER_GROUP}/`);
}

/**
 * Detects Data Braider in the environment: finds its route (preferring the
 * offline metadata cache; falling back to live route enumeration), inspects
 * the route's entity sets, and reports the capability level. Returns
 * `undefined` when Braider is not installed / not discoverable.
 */
export async function detectBraider(
  client: BcClient,
  opts: { refresh?: boolean } = {},
): Promise<BraiderInfo | undefined> {
  const candidates = new Map<string, RouteMetadata | undefined>();

  if (!opts.refresh) {
    for (const cached of await client.cachedMetadata()) {
      if (isBraiderRoutePath(cached.routePath)) {
        candidates.set(cached.routePath, cached.metadata);
      }
    }
  }
  if (!candidates.size) {
    const routes = await client.listRoutes();
    for (const route of routes) {
      const matches =
        (route.publisher?.toLowerCase() === BRAIDER_PUBLISHER &&
          route.group?.toLowerCase() === BRAIDER_GROUP) ||
        isBraiderRoutePath(route.path);
      if (matches) candidates.set(route.path, undefined);
    }
  }
  if (!candidates.size) return undefined;

  const routePath = [...candidates.keys()].sort(
    (a, b) =>
      braiderVersionRank(b.split('/').pop() ?? '') - braiderVersionRank(a.split('/').pop() ?? ''),
  )[0];

  let metadata = candidates.get(routePath);
  if (!metadata || opts.refresh) {
    metadata = (await client.getMetadata(routePath, { refresh: opts.refresh })).metadata;
  }

  const names = new Set(metadata.entitySets.map((s) => s.name.toLowerCase()));
  if (!names.has('read') || !names.has('write')) return undefined;

  const configSets = resolveConfigSets(metadata);
  const hasConfigApi = Boolean(configSets.configs && configSets.lines && configSets.fields);
  return {
    routePath,
    version: routePath.split('/').pop() ?? '',
    level: hasConfigApi ? 'config' : 'readwrite',
    entitySets: metadata.entitySets.map((s) => s.name),
    configSets,
  };
}

// ------------------------------------------------------------------ client

export interface BraiderCallOptions {
  company?: string;
}

export interface BraiderReadOptions extends BraiderCallOptions {
  filters?: BraiderFilter[];
  /** 1-based page index (Braider semantics, NOT a record offset). */
  pageStart?: number;
  /** Top-level records per page. */
  pageSize?: number;
  /** Fetch every page (bounded by topLevelRecordCount — never probes past the end). */
  all?: boolean;
  /** Include the unparsed API row in the result. */
  raw?: boolean;
}

export interface BraiderWriteOptions extends BraiderCallOptions {
  /** Applied to records that carry no `Action` of their own. */
  defaultAction?: BraiderWriteAction;
}

function asInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function decodedEnum(value: unknown): string {
  return typeof value === 'string' ? decodeODataName(value) : '';
}

/**
 * High-level Data Braider client for one environment, wrapping a
 * {@link BcClient}. All HTTP flows through the BcClient (auth, retry,
 * company resolution); this class adds the Braider protocol on top.
 */
export class BraiderClient {
  constructor(
    private readonly client: BcClient,
    readonly info: BraiderInfo,
  ) {}

  private get route(): string {
    return this.info.routePath;
  }

  private configSet(key: keyof BraiderConfigSets, what: string): string {
    const name = this.info.configSets[key];
    if (!name) {
      throw new NavApiError(
        `${what} requires the Data Braider config API (entity set "${CONFIG_SET_CANDIDATES[key]}"), ` +
          `which this environment does not expose. Update Data Braider to 2.4+.`,
      );
    }
    return name;
  }

  // ---------------------------------------------------------------- reads

  /** Lists configured endpoints via the read API auto-list. */
  async listEndpoints(opts: BraiderCallOptions = {}): Promise<BraiderEndpoint[]> {
    const { items } = await this.client.list('read', {
      route: this.route,
      company: opts.company,
      all: true,
    });
    return items.map((row) => this.normalizeEndpoint(row));
  }

  private normalizeEndpoint(row: BcRecord): BraiderEndpoint {
    return {
      code: asString(row.code),
      description: asString(row.description),
      endpointType: decodedEnum(row.endpointType),
      outputJsonType: decodedEnum(row.outputJSONType ?? row.outputJsonType),
      pageStart: asInt(row.pageStart),
      pageSize: asInt(row.pageSize),
      topLevelRecordCount: asInt(row.topLevelRecordCount),
      includedRecordCount: asInt(row.includedRecordCount),
    };
  }

  /**
   * Reads one endpoint's data. Plain GET for the simple case; POST when
   * filters or paging are involved. `jsonResult` double-encoding is unwrapped
   * here — callers get parsed records.
   */
  async readEndpoint(code: string, opts: BraiderReadOptions = {}): Promise<BraiderReadResult> {
    const hasFilters = Boolean(opts.filters?.length);
    if (!hasFilters && !opts.all && opts.pageStart === undefined && opts.pageSize === undefined) {
      const row = await this.client.getRecord('read', code, {
        route: this.route,
        company: opts.company,
      });
      return this.toReadResult(row, opts.raw);
    }

    const first = await this.postRead(code, opts, opts.pageStart ?? 1, opts.pageSize);
    if (!opts.all) return first;

    // The `all` loop is bounded by topLevelRecordCount: asking Braider for a
    // page beyond the data is a server-side ERROR, not an empty page.
    const records = [...first.records];
    let included = first.includedRecordCount ?? 0;
    let pageStart = first.pageStart ?? opts.pageStart ?? 1;
    const pageSize = first.pageSize ?? opts.pageSize ?? 0;
    const total = first.topLevelRecordCount ?? 0;
    while (pageSize > 0 && pageStart * pageSize < total) {
      pageStart += 1;
      const page = await this.postRead(code, opts, pageStart, pageSize);
      if (!page.records.length) break;
      records.push(...page.records);
      included += page.includedRecordCount ?? 0;
    }
    return {
      ...first,
      records,
      includedRecordCount: included || first.includedRecordCount,
      pageStart: first.pageStart ?? opts.pageStart ?? 1,
      hasMore: false,
    };
  }

  private async postRead(
    code: string,
    opts: BraiderReadOptions,
    pageStart?: number,
    pageSize?: number,
  ): Promise<BraiderReadResult> {
    const body: Record<string, unknown> = { code };
    if (opts.filters?.length) body.filterJson = encodeFilterJson(opts.filters);
    if (pageStart !== undefined) body.pageStart = pageStart;
    if (pageSize !== undefined) body.pageSize = pageSize;
    const row = await this.client.create('read', body, {
      route: this.route,
      company: opts.company,
    });
    return this.toReadResult(row, opts.raw);
  }

  private toReadResult(row: BcRecord, includeRaw?: boolean): BraiderReadResult {
    const { records, diagnostics } = parseJsonResult(row.jsonResult);
    const pageStart = asInt(row.pageStart);
    const pageSize = asInt(row.pageSize);
    const total = asInt(row.topLevelRecordCount);
    const hasMore =
      pageStart !== undefined && pageSize !== undefined && total !== undefined && pageSize > 0
        ? pageStart * pageSize < total
        : false;
    return {
      records,
      diagnostics,
      pageStart,
      pageSize,
      topLevelRecordCount: total,
      includedRecordCount: asInt(row.includedRecordCount),
      hasMore,
      ...(includeRaw ? { raw: row } : {}),
    };
  }

  // --------------------------------------------------------------- writes

  /**
   * Submits records to a write endpoint. Records use `"Table.Field"` keys and
   * an `Action` each (Insert | Update | Delete | Upsert); the double-encoded
   * `jsonInput`/`jsonResult` round-trip is handled here.
   */
  async writeEndpoint(
    code: string,
    records: BraiderWriteRecord[],
    opts: BraiderWriteOptions = {},
  ): Promise<BraiderWriteResultEntry[]> {
    if (!records.length) throw new NavApiError('writeEndpoint needs at least one record.');
    const body = { code, jsonInput: encodeJsonInput(records, opts.defaultAction) };
    const row = await this.client.create('write', body, {
      route: this.route,
      company: opts.company,
      etag: '*',
    });
    const { records: results } = parseJsonResult(row.jsonResult);
    return results as BraiderWriteResultEntry[];
  }

  // --------------------------------------------------------------- schema

  /**
   * Per-endpoint field schema. Uses the live schema API when present
   * (Braider 2.4+); otherwise infers a best-effort schema by sampling data.
   */
  async getEndpointSchema(
    code: string,
    opts: BraiderCallOptions = {},
  ): Promise<BraiderEndpointSchema> {
    const schemas = this.info.configSets.schemas;
    if (schemas) {
      const row = await this.client.getRecord(schemas, code, {
        route: this.route,
        company: opts.company,
      });
      return {
        code,
        source: 'api',
        endpointType: decodedEnum(row.endpointType),
        outputJsonType: decodedEnum(row.outputJSONType ?? row.outputJsonType),
        readSchema: parseSchemaJson(row.readSchemaJson, code, 'readSchemaJson'),
        writeSchema: parseSchemaJson(row.writeSchemaJson, code, 'writeSchemaJson'),
      };
    }
    return this.inferSchema(code, opts);
  }

  private async inferSchema(
    code: string,
    opts: BraiderCallOptions,
  ): Promise<BraiderEndpointSchema> {
    const result = await this.readEndpoint(code, { ...opts, pageSize: 25 });
    const properties = new Map<string, string>();
    const visitFlat = (record: Record<string, unknown>, prefix = '') => {
      for (const [key, value] of Object.entries(record)) {
        const name = prefix ? `${prefix}.${key}` : key;
        const type =
          typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string';
        if (!properties.has(name)) properties.set(name, type);
      }
    };
    const visitNode = (node: BraiderHierarchyNode) => {
      if (node.data && typeof node.data === 'object') {
        visitFlat(node.data, node.sourceTableName);
      }
      for (const child of node.children ?? []) visitNode(child);
    };
    for (const record of result.records) {
      if (record && typeof record === 'object') {
        if ('data' in record && 'sourceTableName' in record) {
          visitNode(record as BraiderHierarchyNode);
        } else {
          visitFlat(record as Record<string, unknown>);
        }
      }
    }
    return {
      code,
      source: 'inferred',
      readSchema: [...properties.entries()].map(([name, type]) => ({
        name,
        type,
        required: false,
      })),
    };
  }

  // ----------------------------------------------------------- config CRUD

  /** Full endpoint config records (requires the config API). */
  async listEndpointConfigs(opts: BraiderCallOptions = {}): Promise<BcRecord[]> {
    const set = this.configSet('configs', 'Listing endpoint configs');
    const { items } = await this.client.list(set, {
      route: this.route,
      company: opts.company,
      all: true,
    });
    return items;
  }

  async getEndpointConfig(
    code: string,
    opts: BraiderCallOptions & { includeLines?: boolean; allFields?: boolean } = {},
  ): Promise<BcRecord & { lines?: BcRecord[] }> {
    const config = await this.findConfig(code, opts);
    if (!opts.includeLines) return config;

    const linesSet = this.configSet('lines', 'Reading endpoint lines');
    const fieldsSet = this.configSet('fields', 'Reading endpoint fields');
    const { items: lines } = await this.client.list(linesSet, {
      route: this.route,
      company: opts.company,
      query: { filter: `configCode eq '${escapeODataString(code)}'` },
      all: true,
    });
    const withFields = await Promise.all(
      lines.map(async (line) => {
        const fieldFilter = opts.allFields ? '' : ' and included eq true';
        const { items: fields } = await this.client.list(fieldsSet, {
          route: this.route,
          company: opts.company,
          query: {
            filter: `configCode eq '${escapeODataString(code)}' and configLineNo eq ${line.lineNo}${fieldFilter}`,
          },
          all: true,
        });
        return { ...line, fields };
      }),
    );
    return { ...config, lines: withFields };
  }

  /**
   * Creates a complete endpoint remotely: config header, one line per source
   * table (Braider auto-populates the field rows), then enables the chosen
   * fields. Braider commits per line, so a mid-sequence failure leaves a
   * partially created endpoint — the error names the failing step.
   */
  async createEndpoint(
    spec: BraiderEndpointSpec,
    opts: BraiderCallOptions = {},
  ): Promise<BcRecord> {
    const configsSet = this.configSet('configs', 'Creating endpoints');
    const linesSet = this.configSet('lines', 'Creating endpoints');
    const fieldsSet = this.configSet('fields', 'Creating endpoints');
    const scope = { route: this.route, company: opts.company };

    let step = `create config "${spec.code}"`;
    try {
      const config = await this.client.create(
        configsSet,
        {
          code: spec.code,
          ...(spec.description !== undefined ? { description: spec.description } : {}),
          endpointType: encodeODataName(spec.endpointType),
          ...(spec.outputJsonType ? { outputJsonType: spec.outputJsonType } : {}),
          ...(spec.enabled !== undefined ? { enabled: spec.enabled } : {}),
          ...(spec.hideFromLists !== undefined ? { hideFromLists: spec.hideFromLists } : {}),
          ...(spec.pageSize !== undefined ? { pageSize: spec.pageSize } : {}),
        },
        scope,
      );

      for (const [index, lineSpec] of spec.lines.entries()) {
        const tableNo =
          typeof lineSpec.sourceTable === 'number'
            ? lineSpec.sourceTable
            : await this.resolveTableNo(lineSpec.sourceTable, opts);
        step = `create line ${index + 1} (table ${lineSpec.sourceTable})`;
        const line = await this.client.create(
          linesSet,
          {
            configCode: spec.code,
            sourceTable: tableNo,
            ...(lineSpec.indentation !== undefined ? { indentation: lineSpec.indentation } : {}),
          },
          scope,
        );

        step = `configure fields on line ${index + 1} (table ${lineSpec.sourceTable})`;
        const { items: fieldRows } = await this.client.list(fieldsSet, {
          ...scope,
          query: {
            filter: `configCode eq '${escapeODataString(spec.code)}' and configLineNo eq ${line.lineNo}`,
          },
          all: true,
        });
        for (const fieldSpec of lineSpec.includeFields) {
          const normalized: BraiderFieldSpec =
            typeof fieldSpec === 'object' ? fieldSpec : { field: fieldSpec };
          const row = findFieldRow(fieldRows, normalized.field);
          if (!row || typeof row.id !== 'string') {
            throw new NavApiError(
              `Field "${normalized.field}" not found on table ${lineSpec.sourceTable}. ` +
                `Use listAvailableFields(${tableNo}) to see valid fields.`,
            );
          }
          const patch: Record<string, unknown> = { included: true };
          if (normalized.writeEnabled !== undefined) patch.writeEnabled = normalized.writeEnabled;
          if (normalized.mandatory !== undefined) patch.mandatory = normalized.mandatory;
          if (normalized.filter !== undefined) patch.filter = normalized.filter;
          if (normalized.defaultValue !== undefined) patch.defaultValue = normalized.defaultValue;
          if (normalized.upsertMatch !== undefined) patch.upsertMatch = normalized.upsertMatch;
          if (normalized.manualFieldCaption !== undefined) {
            patch.manualFieldCaption = normalized.manualFieldCaption;
          }
          await this.client.update(fieldsSet, row.id, patch, {
            ...scope,
            etag: asString(row['@odata.etag']) || '*',
          });
        }
      }
      return config;
    } catch (err) {
      if (err instanceof NavApiError && err.message.startsWith('Endpoint creation failed')) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new NavApiError(
        `Endpoint creation failed at step: ${step}. ` +
          `The endpoint may be partially created — inspect it with getEndpointConfig("${spec.code}") ` +
          `or delete it with deleteEndpoint("${spec.code}"). Cause: ${msg}`,
        { cause: err },
      );
    }
  }

  /** PATCHes the endpoint config header (enum values may use plain names). */
  async updateEndpoint(
    code: string,
    patch: Record<string, unknown>,
    opts: BraiderCallOptions = {},
  ): Promise<BcRecord> {
    const set = this.configSet('configs', 'Updating endpoints');
    const config = await this.findConfig(code, opts);
    const prepared = { ...patch };
    if (typeof prepared.endpointType === 'string') {
      prepared.endpointType = encodeODataName(prepared.endpointType);
    }
    return this.client.update(set, String(config.id), prepared, {
      route: this.route,
      company: opts.company,
      etag: asString(config['@odata.etag']) || undefined,
    });
  }

  /** Deletes the endpoint config (cascades to lines/fields/relations server-side). */
  async deleteEndpoint(code: string, opts: BraiderCallOptions = {}): Promise<void> {
    const set = this.configSet('configs', 'Deleting endpoints');
    const config = await this.findConfig(code, opts);
    await this.client.deleteRecord(set, String(config.id), {
      route: this.route,
      company: opts.company,
      etag: asString(config['@odata.etag']) || undefined,
    });
  }

  // -------------------------------------------------------------- lookups

  /** Tables available for endpoint authoring (optionally filtered by substring). */
  async listAvailableTables(
    opts: BraiderCallOptions & { search?: string } = {},
  ): Promise<BcRecord[]> {
    const set = this.configSet('tables', 'Listing available tables');
    const search = opts.search ? escapeODataString(opts.search) : undefined;
    const { items } = await this.client.list(set, {
      route: this.route,
      company: opts.company,
      query: search
        ? { filter: `contains(name,'${search}') or contains(caption,'${search}')` }
        : undefined,
      all: true,
    });
    return items;
  }

  /** Fields of one table (numbers, names, types) for endpoint authoring. */
  async listAvailableFields(tableNo: number, opts: BraiderCallOptions = {}): Promise<BcRecord[]> {
    const set = this.configSet('fieldsLookup', 'Listing available fields');
    const { items } = await this.client.list(set, {
      route: this.route,
      company: opts.company,
      query: { filter: `tableNo eq ${tableNo}` },
      all: true,
    });
    return items;
  }

  private async resolveTableNo(name: string, opts: BraiderCallOptions): Promise<number> {
    const tables = await this.listAvailableTables({ ...opts, search: name });
    const wanted = name.toLowerCase();
    const match = tables.find(
      (t) =>
        asString(t.name).toLowerCase() === wanted || asString(t.caption).toLowerCase() === wanted,
    );
    if (!match || typeof match.tableNo !== 'number') {
      throw new NavApiError(
        `Table "${name}" not found. Use listAvailableTables({search: '${name}'}) to browse.`,
      );
    }
    return match.tableNo;
  }

  private async findConfig(code: string, opts: BraiderCallOptions): Promise<BcRecord> {
    const set = this.configSet('configs', 'Looking up endpoint configs');
    const { items } = await this.client.list(set, {
      route: this.route,
      company: opts.company,
      query: { filter: `code eq '${escapeODataString(code)}'` },
    });
    if (!items.length) {
      throw new NavApiError(`Endpoint config "${code}" not found.`);
    }
    return items[0];
  }
}

function escapeODataString(value: string): string {
  return value.replaceAll("'", "''");
}

function findFieldRow(rows: BcRecord[], field: string | number): BcRecord | undefined {
  if (typeof field === 'number') {
    return rows.find((r) => r.fieldNo === field);
  }
  const wanted = field.toLowerCase();
  return rows.find(
    (r) =>
      asString(r.fieldName).toLowerCase() === wanted ||
      asString(r.fieldCaption).toLowerCase() === wanted,
  );
}

function parseSchemaJson(
  raw: unknown,
  code: string,
  fieldName: string,
): BraiderSchemaProperty[] | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new NavApiError(`Endpoint "${code}" returned invalid JSON in ${fieldName}.`);
  }
  const schema = parsed as {
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  if (!schema.properties) return [];
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties).map(([name, prop]) => ({
    name,
    type: asString(prop.type) || 'string',
    required: required.has(name),
    tableNo: asInt(prop['x-spb-tableNo']),
    fieldNo: asInt(prop['x-spb-fieldNo']),
    writeEnabled:
      typeof prop['x-spb-writeEnabled'] === 'boolean' ? prop['x-spb-writeEnabled'] : undefined,
    primaryKey:
      typeof prop['x-spb-primaryKey'] === 'boolean' ? prop['x-spb-primaryKey'] : undefined,
  }));
}
