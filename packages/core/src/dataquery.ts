import type { TokenProvider } from './auth.js';
import { NavApiError, toHttpError } from './errors.js';

/** The BC MCP server's OAuth resource — a different audience from the BC API. */
export const MCP_RESOURCE = 'https://mcp.businesscentral.dynamics.com';
export const MCP_ENDPOINT = `${MCP_RESOURCE}/`;
const PROTOCOL_VERSION = '2025-11-25';

/** The four tools BC adds when Data Query Tools are active on a configuration. */
export const DATA_QUERY_TOOLS = [
  'bc_data_find_tables',
  'bc_data_get_table_schema',
  'bc_data_get_table_relations',
  'bc_data_query',
] as const;

/** BC caps a page of query rows at 50 and `skip` at 100 000. */
export const DATA_QUERY_MAX_TOP = 50;
export const DATA_QUERY_MAX_SKIP = 100_000;

export interface DataQueryTarget {
  tenantId: string;
  environment: string;
  /** Company **name** (the MCP header does not take a GUID or display name). */
  company: string;
  /** MCP configuration; omitted = the environment's default configuration. */
  configurationName?: string;
}

export interface DataQueryClientOptions {
  auth: TokenProvider;
  target: DataQueryTarget;
  /** Defaults to the public BC MCP endpoint. */
  endpoint?: string;
  fetch?: typeof globalThis.fetch;
}

export interface TableMatch {
  tableId: number;
  tableName: string;
  /** Present for semantic searches only. */
  score?: number;
}

export interface TableField {
  name: string;
  /** `Code`, `Text`, `Decimal`, `Option`, … — BC does not report lengths here. */
  type: string;
  /** Option captions, in ordinal order, for `Option` fields. */
  options?: string[];
  fieldClass: 'Normal' | 'FlowField' | 'FlowFilter';
  /** The FlowField's CalcFormula, e.g. `Sum("Detailed Cust. Ledg. Entry"."Amount")`. */
  calcFormula?: string;
  /** TableRelation target, conditions included, e.g. `Post Code [WHERE …]`. */
  relation?: string;
}

export interface TableSchema {
  tableId: number;
  tableName: string;
  primaryKey: string[];
  fields: TableField[];
}

export interface TableSchemaOptions {
  fieldClass?: TableField['fieldClass'];
  /** Keep fields whose name contains any of these (case-insensitive). */
  nameContains?: string[];
}

export interface TableRelation {
  tableId: number;
  tableName: string;
  viaFields: { fieldNo: number; fieldName: string; conditions?: string }[];
}

export interface TableRelations {
  tableId: number;
  tableName: string;
  direction: 'outgoing' | 'incoming';
  relations: TableRelation[];
}

export interface DataQueryOptions {
  /** Rows to skip before the first returned row. */
  skip?: number;
  /** Rows to return. Above 50 the client pages for you; omit with `all` for everything. */
  top?: number;
  /** Page until the query is exhausted (bounded by `top` when given). */
  all?: boolean;
}

export interface DataQueryResult {
  columns: string[];
  rows: unknown[][];
  /** Total matching rows — BC reports it on the page that starts at skip 0. */
  totalCount?: number;
}

export interface QueryValidation {
  status: string;
  columns: { name: string; type: string; aggregation?: string }[];
  dataItems: { alias: string; tableId: number; tableName: string }[];
}

/** Thrown when the environment cannot serve data queries at all, with what to do about it. */
export class DataQueryUnavailableError extends NavApiError {}

type RawRelation<Role extends string> = {
  [K in `${Role}TableId`]: number;
} & { [K in `${Role}TableName`]: string } & { viaFields: TableRelation['viaFields'] };

interface ToolContent {
  type: string;
  text?: string;
  resource?: { text?: string };
}

interface ToolResult {
  content?: ToolContent[];
  isError?: boolean;
}

/** Where an admin turns Data Query Tools on: the MCP Server Configurations page. */
export function mcpConfigPageUrl(
  target: Pick<DataQueryTarget, 'tenantId' | 'environment'>,
): string {
  return `https://businesscentral.dynamics.com/${target.tenantId}/${encodeURIComponent(
    target.environment,
  )}?page=8350`;
}

/**
 * Header values must be ASCII; anything else goes as `=?base64?…?=` (UTF-8),
 * which is what BC's MCP server decodes. Company names like "Stefan Maroń
 * Consulting" are common enough that this is not an edge case.
 */
export function encodeMcpHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value)
    ? value
    : `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Streamable HTTP answers either as JSON or as an SSE stream; take the last JSON-RPC message. */
export function parseMcpBody(text: string, contentType: string): unknown {
  if (!contentType.includes('text/event-stream')) return text ? JSON.parse(text) : undefined;
  const data = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());
  const last = data.at(-1);
  return last ? JSON.parse(last) : undefined;
}

/**
 * Parses `bc_data_get_table_schema`'s pipe-delimited text. BC returns text,
 * not JSON, for this one tool; keeping the parse here means no face has to.
 */
export function parseTableSchema(text: string): TableSchema {
  const lines = text.split(/\r?\n/);
  const header = /^Table: (.*) \(ID: (\d+)\)$/.exec(lines[0] ?? '');
  if (!header) throw new NavApiError(`Unexpected table schema format: ${lines[0] ?? '(empty)'}`);
  const schema: TableSchema = {
    tableName: header[1] as string,
    tableId: Number(header[2]),
    primaryKey: [],
    fields: [],
  };
  for (const line of lines.slice(1)) {
    if (line.startsWith('Primary Key: ')) {
      schema.primaryKey = line
        .slice('Primary Key: '.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      continue;
    }
    const parts = line.split(' | ');
    if (parts.length < 2) continue; // blank lines and the "Showing: …" summary
    const [name, rawType, ...annotations] = parts as [string, string, ...string[]];
    const field: TableField = { name, type: rawType, fieldClass: 'Normal' };
    if (rawType.startsWith('Option:')) {
      field.type = 'Option';
      // AL writes the blank member as `" "`; Format() renders it as ''.
      field.options = rawType
        .slice('Option:'.length)
        .split(',')
        .map((o) => o.trim());
    }
    for (const note of annotations) {
      if (note === 'FlowFilter') field.fieldClass = 'FlowFilter';
      else if (note.startsWith('FlowField: ')) {
        field.fieldClass = 'FlowField';
        field.calcFormula = note.slice('FlowField: '.length);
      } else if (note.startsWith('rel: ')) field.relation = note.slice('rel: '.length);
    }
    schema.fields.push(field);
  }
  return schema;
}

function resultText(result: ToolResult): string[] {
  return (result.content ?? [])
    .map((c) => c.text ?? c.resource?.text)
    .filter((t): t is string => typeof t === 'string');
}

/**
 * Client for Business Central's **Data Query Tools** — the MCP server feature
 * (BC 29+) that compiles and runs an AL query on demand, so any table can be
 * read without an API page or query being published for it.
 *
 * It speaks MCP over HTTP to `mcp.businesscentral.dynamics.com` rather than
 * OData, with a token for the MCP audience. The feature is off by default and
 * billed by Microsoft, and turning it on takes an admin's explicit consent in
 * the BC client — so this client only ever reads, and when the feature is off
 * it says where to turn it on instead of trying to.
 */
export class DataQueryClient {
  readonly target: DataQueryTarget;
  private readonly auth: TokenProvider;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private session?: Promise<string | undefined>;
  private toolCheck?: Promise<void>;
  private nextId = 1;

  constructor(options: DataQueryClientOptions) {
    this.auth = options.auth;
    this.target = options.target;
    this.endpoint = options.endpoint ?? MCP_ENDPOINT;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  /** Finds tables by comma-separated name fragments, or by meaning (`semantic`). */
  async findTables(
    searchText: string,
    opts: { semantic?: boolean; top?: number } = {},
  ): Promise<TableMatch[]> {
    const text = await this.callTool('bc_data_find_tables', {
      searchText,
      searchMode: opts.semantic ? 'semantic' : 'keyword',
      ...(opts.top ? { top: opts.top } : {}),
    });
    return (JSON.parse(text) as { tables?: TableMatch[] }).tables ?? [];
  }

  /**
   * Resolves a table given as an ID or a name. A name must match exactly
   * (case-insensitive) — a fuzzy hit would query the wrong table silently.
   */
  async resolveTableId(table: string | number): Promise<number> {
    if (typeof table === 'number' || /^\d+$/.test(table)) return Number(table);
    const wanted = table.trim().toLowerCase();
    const hits = await this.findTables(table, { top: 50 });
    const exact = hits.find((t) => t.tableName.toLowerCase() === wanted);
    if (exact) return exact.tableId;
    const near = hits
      .slice(0, 5)
      .map((t) => `${t.tableName} (${t.tableId})`)
      .join(', ');
    throw new NavApiError(
      `No table named "${table}".${near ? ` Close matches: ${near}.` : ''} Pass the table ID instead.`,
    );
  }

  async getTableSchema(
    table: string | number,
    opts: TableSchemaOptions = {},
  ): Promise<TableSchema> {
    const tableId = await this.resolveTableId(table);
    const text = await this.callTool('bc_data_get_table_schema', {
      tableId,
      ...(opts.fieldClass ? { fieldClass: opts.fieldClass } : {}),
      ...(opts.nameContains?.length ? { nameContains: opts.nameContains } : {}),
    });
    return parseTableSchema(text);
  }

  async getTableRelations(
    table: string | number,
    opts: { direction?: 'outgoing' | 'incoming'; relatedTo?: number[] } = {},
  ): Promise<TableRelations> {
    const tableId = await this.resolveTableId(table);
    const direction = opts.direction ?? 'outgoing';
    const text = await this.callTool('bc_data_get_table_relations', {
      tableId,
      direction,
      ...(opts.relatedTo?.length ? { relatedToTableIds: opts.relatedTo } : {}),
    });
    // BC names the far table by role: `target…` going out, `referencing…` coming in.
    const raw = JSON.parse(text) as {
      tableId: number;
      tableName: string;
      outgoing?: RawRelation<'target'>[];
      incoming?: RawRelation<'referencing'>[];
    };
    const relations: TableRelation[] =
      direction === 'outgoing'
        ? (raw.outgoing ?? []).map((r) => ({
            tableId: r.targetTableId,
            tableName: r.targetTableName,
            viaFields: r.viaFields,
          }))
        : (raw.incoming ?? []).map((r) => ({
            tableId: r.referencingTableId,
            tableName: r.referencingTableName,
            viaFields: r.viaFields,
          }));
    return { tableId: raw.tableId, tableName: raw.tableName, direction, relations };
  }

  /**
   * Compiles an AL query without running it, resolving to the columns and
   * data items BC compiled. A compile error rejects with the compiler's
   * diagnostics.
   */
  async validateQuery(queryText: string): Promise<QueryValidation> {
    return JSON.parse(await this.callTool('bc_data_query', { queryText, returnData: false }));
  }

  /**
   * Runs an AL query. BC returns at most 50 rows per call, so larger `top`
   * values and `all` page through it here — bounded by BC's skip limit, which
   * is reported rather than silently truncated.
   */
  async runQuery(queryText: string, opts: DataQueryOptions = {}): Promise<DataQueryResult> {
    const start = opts.skip ?? 0;
    const limit = opts.top ?? (opts.all ? Number.POSITIVE_INFINITY : 10);
    const result: DataQueryResult = { columns: [], rows: [] };
    let skip = start;
    while (result.rows.length < limit) {
      if (skip > DATA_QUERY_MAX_SKIP) {
        throw new NavApiError(
          `Stopped after ${result.rows.length} rows: Business Central does not page past row ${DATA_QUERY_MAX_SKIP}. ` +
            'Narrow the query with a filter, or aggregate it.',
        );
      }
      const want = Math.min(DATA_QUERY_MAX_TOP, limit - result.rows.length);
      const page = await this.queryPage(queryText, skip, want);
      if (!result.columns.length) result.columns = page.columns;
      if (page.totalCount !== undefined) result.totalCount ??= page.totalCount;
      result.rows.push(...page.rows);
      skip += page.rows.length;
      const exhausted =
        page.rows.length < want || (result.totalCount !== undefined && skip >= result.totalCount);
      if (exhausted) break;
    }
    return result;
  }

  private async queryPage(queryText: string, skip: number, top: number): Promise<DataQueryResult> {
    const texts = await this.callToolTexts('bc_data_query', {
      queryText,
      returnData: true,
      top,
      skip,
      resultFormat: 'text',
    });
    // The first content item is a human summary; the data is the JSON one.
    for (const text of texts) {
      if (!text.trimStart().startsWith('{')) continue;
      const page = JSON.parse(text) as Partial<DataQueryResult>;
      if (Array.isArray(page.columns) && Array.isArray(page.rows)) {
        return { columns: page.columns, rows: page.rows, totalCount: page.totalCount };
      }
    }
    throw new NavApiError(`Unexpected bc_data_query response: ${texts.join(' ').slice(0, 300)}`);
  }

  // ------------------------------------------------------------------ MCP

  private async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    return (await this.callToolTexts(name, args)).join('\n');
  }

  private async callToolTexts(name: string, args: Record<string, unknown>): Promise<string[]> {
    await this.ensureDataQueryTools();
    const result = (await this.rpc('tools/call', { name, arguments: args })) as ToolResult;
    const texts = resultText(result);
    // Tool-level failures (compile errors, unknown table) come back as a
    // normal result flagged isError — BC's own message is the useful part.
    if (result.isError) throw new NavApiError(texts.join('\n') || `${name} failed`);
    return texts;
  }

  /**
   * Checks once per client that the configuration actually carries the data
   * query tools. Without the feature the session still opens fine and just
   * lists other tools, so this is the only place the gap shows.
   */
  private ensureDataQueryTools(): Promise<void> {
    this.toolCheck ??= (async () => {
      const listed = (await this.rpc('tools/list', {})) as { tools?: { name: string }[] };
      const names = new Set((listed.tools ?? []).map((t) => t.name));
      if (DATA_QUERY_TOOLS.every((t) => names.has(t))) return;
      throw new DataQueryUnavailableError(
        `Data Query Tools are not enabled in ${this.configLabel()} of environment "${this.target.environment}". ` +
          `An admin can turn them on: open ${mcpConfigPageUrl(this.target)}, pick or create a configuration, ` +
          'activate "Data Query Tools" under Server Features, and activate the configuration. ' +
          'Microsoft bills this feature; activating it shows the pricing notice. Requires Business Central 29 or later.' +
          (this.target.configurationName
            ? ''
            : ' Then name that configuration: --mcp-config in the CLI, mcpConfig in MCP tools.'),
      );
    })();
    this.toolCheck.catch(() => {
      this.toolCheck = undefined;
    });
    return this.toolCheck;
  }

  private configLabel(): string {
    return this.target.configurationName
      ? `MCP configuration "${this.target.configurationName}"`
      : 'the default MCP configuration';
  }

  private ensureSession(): Promise<string | undefined> {
    this.session ??= (async () => {
      const { sessionId } = await this.post({
        jsonrpc: '2.0',
        id: this.nextId++,
        method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'navapi', version: '1' },
        },
      });
      await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId);
      return sessionId;
    })();
    this.session.catch(() => {
      this.session = undefined;
    });
    return this.session;
  }

  private async rpc(method: string, params: unknown, retried = false): Promise<unknown> {
    const sessionId = await this.ensureSession();
    try {
      const { body } = await this.post(
        { jsonrpc: '2.0', id: this.nextId++, method, params },
        sessionId,
      );
      const message = body as { result?: unknown; error?: { code: number; message: string } };
      if (message?.error) {
        throw new NavApiError(
          `MCP ${method} failed: ${message.error.message} (${message.error.code})`,
        );
      }
      return message?.result;
    } catch (err) {
      // The MCP spec answers an expired session with 404; start a new one once.
      if (!retried && err instanceof SessionExpired) {
        this.session = undefined;
        return this.rpc(method, params, true);
      }
      throw err;
    }
  }

  private async post(
    message: Record<string, unknown>,
    sessionId?: string,
  ): Promise<{ body: unknown; sessionId?: string }> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${await this.auth.getToken()}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTOCOL_VERSION,
      tenantid: this.target.tenantId,
      environmentname: encodeMcpHeader(this.target.environment),
      company: encodeMcpHeader(this.target.company),
    };
    if (this.target.configurationName) {
      headers.configurationname = encodeMcpHeader(this.target.configurationName);
    }
    if (sessionId) headers['mcp-session-id'] = sessionId;

    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
      });
    } catch (cause) {
      throw new NavApiError(`Could not reach the Business Central MCP server at ${this.endpoint}`, {
        cause,
      });
    }
    const text = await res.text();
    if (res.status === 404 && sessionId) throw new SessionExpired();
    if (!res.ok) throw this.httpFailure(res.status, text);
    const contentType = res.headers.get('content-type') ?? '';
    return {
      body: res.status === 202 ? undefined : parseMcpBody(text, contentType),
      sessionId: res.headers.get('mcp-session-id') ?? sessionId,
    };
  }

  /** Turns BC's setup errors into messages that say what to change. */
  private httpFailure(status: number, text: string): NavApiError {
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // keep the raw text
    }
    const err = toHttpError(status, body);
    if (/MCP Configuration named .* was not found or not active/i.test(err.message)) {
      return new DataQueryUnavailableError(
        `${this.configLabel()} was not found or is not active in environment "${this.target.environment}". ` +
          `Check the name on ${mcpConfigPageUrl(this.target)} — the configuration must be active, ` +
          'with "Data Query Tools" activated under Server Features. Requires Business Central 29 or later.',
        { cause: err },
      );
    }
    if (status === 401) {
      return new NavApiError(
        `The Business Central MCP server rejected the token (HTTP 401). It needs a token for ${MCP_RESOURCE}, ` +
          'issued to a user — app-only (client secret) credentials may not be accepted.',
        { cause: err },
      );
    }
    return err;
  }
}

class SessionExpired extends NavApiError {
  constructor() {
    super('MCP session expired');
  }
}
