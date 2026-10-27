import { readFile } from 'node:fs/promises';
import {
  createDataQueryClientForSelector,
  type DataQueryClient,
  type DataQueryResult,
  NavApiError,
  type TableField,
} from '@navapi/core';
import type { Command } from 'commander';
import pc from 'picocolors';
import type { ClientSelector } from '../context.js';
import { emitJson, printTable, wantJson } from '../output.js';

interface DataQueryFlags {
  company?: string;
  mcpConfig?: string;
}

function withDataQueryOptions<T extends Command>(command: T): T {
  return command
    .option('--company <company>', 'Company override for this call')
    .option(
      '--mcp-config <name>',
      'MCP configuration with Data Query Tools active (env: NAVAPI_MCP_CONFIG; default: the environment default)',
    )
    .option('--json', 'JSON output') as T;
}

function dataQueryClient(globals: ClientSelector & DataQueryFlags): Promise<DataQueryClient> {
  return createDataQueryClientForSelector({
    ...globals,
    company: globals.company,
    configurationName: globals.mcpConfig,
  });
}

/** Rows as objects keyed by column — the shape every other navapi command emits. */
export function rowsAsRecords(result: DataQueryResult): Record<string, unknown>[] {
  return result.rows.map((row) =>
    Object.fromEntries(result.columns.map((column, i) => [column, row[i]])),
  );
}

/** An AL query from a file, stdin (`-`), or inline text. */
async function readQuerySource(source: string): Promise<string> {
  if (source === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }
  if (/^\s*query\s+\d+/i.test(source)) return source;
  try {
    return await readFile(source, 'utf8');
  } catch (cause) {
    throw new NavApiError(`Cannot read query file "${source}"`, { cause });
  }
}

function fieldNote(field: TableField): string {
  if (field.calcFormula) return field.calcFormula;
  if (field.relation) return `→ ${field.relation}`;
  if (field.options) return field.options.map((o) => o || "' '").join(', ');
  return '';
}

export function registerDataQuery(program: Command): void {
  const table = program
    .command('table')
    .description(
      'Explore any table through Data Query Tools (BC 29+, MCP server feature an admin must enable)',
    );

  withDataQueryOptions(
    table
      .command('find <searchText>')
      .description('Find tables by comma-separated name fragments, or by meaning with --semantic')
      .option('--semantic', 'Natural-language search instead of name matching')
      .option('--top <n>', 'Maximum results (max 50)', Number),
  ).action(async (searchText: string, opts, cmd) => {
    const dq = await dataQueryClient(cmd.optsWithGlobals());
    const tables = await dq.findTables(searchText, { semantic: opts.semantic, top: opts.top });
    if (wantJson(opts.json)) emitJson(tables);
    else
      printTable(
        tables,
        opts.semantic ? ['tableId', 'tableName', 'score'] : ['tableId', 'tableName'],
      );
  });

  withDataQueryOptions(
    table
      .command('schema <table>')
      .description('Fields of a table (ID or exact name): types, options, relations, FlowFields')
      .option('--field-class <class>', 'Only Normal, FlowField, or FlowFilter fields')
      .option('--name <fragment...>', 'Only fields whose name contains any of these'),
  ).action(async (tableArg: string, opts, cmd) => {
    const dq = await dataQueryClient(cmd.optsWithGlobals());
    const schema = await dq.getTableSchema(tableArg, {
      fieldClass: opts.fieldClass,
      nameContains: opts.name,
    });
    if (wantJson(opts.json)) {
      emitJson(schema);
      return;
    }
    console.log(
      `${pc.bold(schema.tableName)} ${pc.dim(`(${schema.tableId})`)}  key: ${schema.primaryKey.join(', ')}`,
    );
    printTable(
      schema.fields.map((f) => ({
        name: f.name,
        type: f.type,
        class: f.fieldClass,
        note: fieldNote(f),
      })),
      ['name', 'type', 'class', 'note'],
    );
  });

  withDataQueryOptions(
    table
      .command('relations <table>')
      .description('Tables this one references (default), or that reference it (--incoming)')
      .option('--incoming', 'Show tables that reference this one')
      .option('--related <tableIds>', 'Only relations with these table IDs (comma-separated)'),
  ).action(async (tableArg: string, opts, cmd) => {
    const dq = await dataQueryClient(cmd.optsWithGlobals());
    const relations = await dq.getTableRelations(tableArg, {
      direction: opts.incoming ? 'incoming' : 'outgoing',
      relatedTo: opts.related ? String(opts.related).split(',').map(Number) : undefined,
    });
    if (wantJson(opts.json)) {
      emitJson(relations);
      return;
    }
    printTable(
      relations.relations.map((r) => ({
        tableId: r.tableId,
        tableName: r.tableName,
        via: r.viaFields
          .map((f) => (f.conditions ? `${f.fieldName} (${f.conditions})` : f.fieldName))
          .join('; '),
      })),
      ['tableId', 'tableName', 'via'],
    );
  });

  withDataQueryOptions(
    program
      .command('query <source>')
      .description(
        'Run an AL query (file, "-" for stdin, or inline text) through Data Query Tools — read-only',
      )
      .option('--top <n>', 'Rows to return (default 10; pages past BC’s 50-row cap)', Number)
      .option('--skip <n>', 'Rows to skip', Number)
      .option('--all', 'Return every row')
      .option('--validate', 'Compile only; print the column schema without running')
      .option('--count', 'Wrap JSON output as {totalCount, rows}'),
  ).action(async (source: string, opts, cmd) => {
    const dq = await dataQueryClient(cmd.optsWithGlobals());
    const queryText = await readQuerySource(source);
    if (opts.validate) {
      const compiled = await dq.validateQuery(queryText);
      if (wantJson(opts.json)) emitJson(compiled);
      else printTable(compiled.columns, ['name', 'type', 'aggregation']);
      return;
    }
    const result = await dq.runQuery(queryText, { top: opts.top, skip: opts.skip, all: opts.all });
    const rows = rowsAsRecords(result);
    if (wantJson(opts.json)) {
      emitJson(opts.count ? { totalCount: result.totalCount, rows } : rows);
      return;
    }
    printTable(rows, result.columns);
    if (result.totalCount !== undefined && result.totalCount > rows.length) {
      console.error(
        pc.dim(`${rows.length} of ${result.totalCount} rows — use --top, --skip, or --all`),
      );
    }
  });
}
