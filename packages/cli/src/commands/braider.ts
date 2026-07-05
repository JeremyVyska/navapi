import {
  BraiderClient,
  type BraiderClient as BraiderClientType,
  type BraiderEndpointSpec,
  type BraiderFilter,
  type BraiderHierarchyNode,
  type BraiderWriteAction,
  type BraiderWriteRecord,
  detectBraider,
  NavApiError,
  parseBraiderFilterSpec,
} from '@navapi/core';
import type { Command } from 'commander';
import pc from 'picocolors';
import { createClient } from '../context.js';
import { readJsonSource } from '../json-input.js';
import { emitJson, printRecord, printTable, wantJson } from '../output.js';
import { confirm } from '../prompt.js';
import { parseSetArgs } from './crud.js';

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

async function braiderFor(profileName: string | undefined): Promise<BraiderClientType> {
  const client = await createClient(profileName);
  const info = await detectBraider(client);
  if (!info) {
    throw new NavApiError(
      'Data Braider was not detected in this environment. ' +
        'Run "navapi discover --refresh" to re-enumerate routes, or check that the extension is installed.',
    );
  }
  return new BraiderClient(client, info);
}

async function gatherFilters(opts: {
  filter?: string[];
  filters?: string;
}): Promise<BraiderFilter[]> {
  const filters = (opts.filter ?? []).map(parseBraiderFilterSpec);
  if (opts.filters) {
    const raw = await readJsonSource(opts.filters);
    if (!Array.isArray(raw)) {
      throw new NavApiError('--filters must be a JSON array of {table, field, filter} objects.');
    }
    filters.push(...(raw as BraiderFilter[]));
  }
  return filters;
}

function isHierarchyNode(record: unknown): record is BraiderHierarchyNode {
  return (
    typeof record === 'object' && record !== null && 'data' in record && 'sourceTableName' in record
  );
}

/** Rows for human display: hierarchy nodes flatten to their data + child count. */
function displayRows(records: unknown[]): Record<string, unknown>[] {
  return records.map((r) => {
    if (isHierarchyNode(r)) {
      return { ...r.data, children: r.children?.length ?? 0 };
    }
    return (r ?? {}) as Record<string, unknown>;
  });
}

export function registerBraider(program: Command): void {
  const braider = program
    .command('braider')
    .description('Work with Data Braider endpoints (discovery, read/write, schema, authoring)');

  braider
    .command('status')
    .description('Detect Data Braider and report its capability level')
    .option('--refresh', 'Re-enumerate routes and refetch metadata')
    .option('--json', 'JSON output')
    .action(async (opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const client = await createClient(globals.profile);
      const info = await detectBraider(client, { refresh: opts.refresh });
      if (wantJson(opts.json)) {
        emitJson(info ? { installed: true, ...info } : { installed: false });
        return;
      }
      if (!info) {
        console.log(pc.yellow('Data Braider: not detected.'));
        console.log(pc.dim('If it was just installed, try: navapi braider status --refresh'));
        return;
      }
      console.log(`${pc.green('Data Braider detected')} at ${pc.bold(info.routePath)}`);
      console.log(
        `capability: ${pc.bold(info.level === 'config' ? 'read/write + config API (2.4+)' : 'read/write only')}`,
      );
      if (info.level === 'readwrite') {
        console.log(
          pc.dim('Schema is inferred from data; endpoint authoring needs Data Braider 2.4+.'),
        );
      }
    });

  braider
    .command('ls')
    .description('List configured Data Braider endpoints')
    .option('--company <company>', 'Company override for this call')
    .option('--json', 'JSON output')
    .action(async (opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const bc = await braiderFor(globals.profile);
      const endpoints = await bc.listEndpoints({ company: opts.company });
      if (wantJson(opts.json)) {
        emitJson(endpoints);
        return;
      }
      printTable(
        endpoints.map((e) => ({
          code: e.code,
          description: e.description,
          type: e.endpointType,
          output: e.outputJsonType,
        })),
        ['code', 'description', 'type', 'output'],
      );
    });

  braider
    .command('get <code>')
    .description('Read data from a Data Braider endpoint (unwraps the JSON payload)')
    .option(
      '--filter <spec>',
      'Braider filter Table.Field=expr (BC filter syntax), e.g. "Customer.No.=10000..20000"; repeatable',
      collect,
      [],
    )
    .option('--filters <json|file|->', 'Raw JSON array of {table, field, filter}')
    .option('--page-start <n>', '1-based page index', Number)
    .option('--page-size <n>', 'Top-level records per page', Number)
    .option('--all', 'Fetch every page')
    .option('--raw', 'Emit the raw API row (jsonResult still double-encoded)')
    .option('--diagnostics', 'Include the diagnostics envelope in JSON output')
    .option('--company <company>', 'Company override for this call')
    .option('--json', 'JSON output')
    .action(async (code: string, opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const bc = await braiderFor(globals.profile);
      const result = await bc.readEndpoint(code, {
        filters: await gatherFilters(opts),
        pageStart: opts.pageStart,
        pageSize: opts.pageSize,
        all: opts.all,
        raw: opts.raw,
        company: opts.company,
      });
      if (opts.raw) {
        emitJson(result.raw ?? null);
        return;
      }
      if (wantJson(opts.json)) {
        // Bare-array shape stays stable; --diagnostics opts into an envelope.
        if (opts.diagnostics) {
          emitJson({ records: result.records, diagnostics: result.diagnostics ?? null });
        } else {
          emitJson(result.records);
        }
        return;
      }
      printTable(displayRows(result.records));
      if (result.hasMore) {
        const next = (result.pageStart ?? 1) + 1;
        console.error(
          pc.dim(
            `More records available (${result.topLevelRecordCount} total) — ` +
              `--page-start ${next} for the next page, or --all for everything.`,
          ),
        );
      }
    });

  braider
    .command('write <code>')
    .description('Submit records to a Data Braider write endpoint')
    .requiredOption(
      '--body <json|file|->',
      'JSON array of records with "Table.Field" keys; each needs an Action unless --action is given',
    )
    .option(
      '--action <action>',
      'Default Action for records without one (Insert|Update|Delete|Upsert)',
    )
    .option('--yes', 'Skip the confirmation prompt for deletes')
    .option('--company <company>', 'Company override for this call')
    .option('--json', 'JSON output')
    .action(async (code: string, opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const raw = await readJsonSource(opts.body);
      const records = (Array.isArray(raw) ? raw : [raw]) as BraiderWriteRecord[];
      const hasDeletes = records.some((r) => (r.Action ?? opts.action) === 'Delete');
      if (hasDeletes && !opts.yes && process.stdin.isTTY && process.stdout.isTTY) {
        const count = records.filter((r) => (r.Action ?? opts.action) === 'Delete').length;
        const ok = await confirm(`Submit ${count} Delete action(s) to "${code}"?`);
        if (!ok) {
          console.log(pc.dim('Aborted.'));
          return;
        }
      }
      const bc = await braiderFor(globals.profile);
      const results = await bc.writeEndpoint(code, records, {
        defaultAction: opts.action as BraiderWriteAction | undefined,
        company: opts.company,
      });
      if (wantJson(opts.json)) {
        emitJson(results);
        return;
      }
      console.log(pc.green(`✔ ${results.length} result(s) from "${code}"`));
      printTable(
        results.map((r) => ({
          action: r.action,
          detail: r.gravestonePK ?? (Array.isArray(r.data) ? `${r.data.length} row(s)` : ''),
        })),
        ['action', 'detail'],
      );
    });

  braider
    .command('schema <code>')
    .description('Show an endpoint’s field schema (live API on Braider 2.4+, else inferred)')
    .option('--company <company>', 'Company override for this call')
    .option('--json', 'JSON output')
    .action(async (code: string, opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const bc = await braiderFor(globals.profile);
      const schema = await bc.getEndpointSchema(code, { company: opts.company });
      if (wantJson(opts.json)) {
        emitJson(schema);
        return;
      }
      console.log(
        `${pc.bold(pc.cyan(code))} ${pc.dim(
          `schema (${schema.source === 'api' ? 'live' : 'inferred from sampled data'})`,
        )}`,
      );
      if (schema.readSchema?.length) {
        console.log(pc.bold('\nread'));
        printTable(
          schema.readSchema.map((p) => ({
            property: p.name,
            type: p.type,
            required: p.required ? 'required' : '',
            pk: p.primaryKey ? 'PK' : '',
          })),
          ['property', 'type', 'required', 'pk'],
        );
      }
      if (schema.writeSchema?.length) {
        console.log(pc.bold('\nwrite'));
        printTable(
          schema.writeSchema.map((p) => ({
            property: p.name,
            type: p.type,
            required: p.required ? 'required' : '',
          })),
          ['property', 'type', 'required'],
        );
      }
      if (schema.source === 'inferred') {
        console.log(
          pc.dim(
            '\nInferred from data — field types are approximate. Braider 2.4+ serves exact schemas.',
          ),
        );
      }
    });

  braider
    .command('tables [search]')
    .description('List tables available for endpoint authoring (Braider 2.4+)')
    .option('--company <company>', 'Company override for this call')
    .option('--json', 'JSON output')
    .action(async (search: string | undefined, opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const bc = await braiderFor(globals.profile);
      const tables = await bc.listAvailableTables({ search, company: opts.company });
      if (wantJson(opts.json)) emitJson(tables);
      else printTable(tables, ['tableNo', 'name', 'caption']);
    });

  braider
    .command('fields <tableNo>')
    .description('List fields of a table for endpoint authoring (Braider 2.4+)')
    .option('--company <company>', 'Company override for this call')
    .option('--json', 'JSON output')
    .action(async (tableNo: string, opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const bc = await braiderFor(globals.profile);
      const fields = await bc.listAvailableFields(Number(tableNo), { company: opts.company });
      if (wantJson(opts.json)) emitJson(fields);
      else printTable(fields, ['fieldNo', 'name', 'caption', 'type', 'isPartOfPrimaryKey']);
    });

  const config = braider
    .command('config')
    .description('Author Data Braider endpoints remotely (requires Braider 2.4+)');

  config
    .command('ls')
    .description('List endpoint configs with full detail')
    .option('--company <company>', 'Company override for this call')
    .option('--json', 'JSON output')
    .action(async (opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const bc = await braiderFor(globals.profile);
      const configs = await bc.listEndpointConfigs({ company: opts.company });
      if (wantJson(opts.json)) emitJson(configs);
      else printTable(configs, ['code', 'description', 'endpointType', 'enabled']);
    });

  config
    .command('get <code>')
    .description('Show one endpoint config, its lines and included fields')
    .option('--all-fields', 'Include non-included fields too (verbose)')
    .option('--company <company>', 'Company override for this call')
    .option('--json', 'JSON output')
    .action(async (code: string, opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const bc = await braiderFor(globals.profile);
      const cfg = await bc.getEndpointConfig(code, {
        includeLines: true,
        allFields: opts.allFields,
        company: opts.company,
      });
      if (wantJson(opts.json)) {
        emitJson(cfg);
        return;
      }
      const { lines, ...header } = cfg;
      printRecord(header);
      for (const line of lines ?? []) {
        console.log(
          `\n${pc.bold(pc.cyan(`line ${line.lineNo}`))} ${pc.dim(
            `table ${line.sourceTable} (${line.sourceTableName ?? ''})`,
          )}`,
        );
        printTable((line as { fields?: Record<string, unknown>[] }).fields ?? [], [
          'fieldNo',
          'fieldName',
          'included',
          'writeEnabled',
          'mandatory',
        ]);
      }
    });

  config
    .command('create')
    .description('Create a complete endpoint from a JSON spec')
    .requiredOption(
      '--body <json|file|->',
      'Spec: {code, endpointType, lines: [{sourceTable, includeFields: [...]}, ...]}',
    )
    .option('--company <company>', 'Company override for this call')
    .option('--json', 'JSON output')
    .action(async (opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const spec = (await readJsonSource(opts.body)) as BraiderEndpointSpec;
      const bc = await braiderFor(globals.profile);
      const created = await bc.createEndpoint(spec, { company: opts.company });
      if (wantJson(opts.json)) emitJson(created);
      else {
        console.log(pc.green(`✔ created endpoint "${spec.code}"`));
        console.log(pc.dim(`Verify with: navapi braider schema ${spec.code}`));
      }
    });

  config
    .command('update <code>')
    .description('Update an endpoint config header')
    .option('--set <key=value>', 'Field to set; repeatable', collect, [])
    .option('--body <json|file|->', 'JSON object of fields to patch')
    .option('--company <company>', 'Company override for this call')
    .option('--json', 'JSON output')
    .action(async (code: string, opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const fromBody = opts.body ? await readJsonSource(opts.body) : {};
      if (typeof fromBody !== 'object' || fromBody === null || Array.isArray(fromBody)) {
        throw new NavApiError('--body must be a JSON object for update');
      }
      const patch = { ...(fromBody as Record<string, unknown>), ...parseSetArgs(opts.set) };
      if (!Object.keys(patch).length) {
        throw new NavApiError('Nothing to update. Use --set key=value or --body.');
      }
      const bc = await braiderFor(globals.profile);
      const updated = await bc.updateEndpoint(code, patch, { company: opts.company });
      if (wantJson(opts.json)) emitJson(updated);
      else {
        console.log(pc.green(`✔ updated "${code}"`));
        printRecord(updated);
      }
    });

  config
    .command('delete <code>')
    .description('Delete an endpoint config (cascades to lines/fields/relations)')
    .option('--yes', 'Skip confirmation')
    .option('--company <company>', 'Company override for this call')
    .action(async (code: string, opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      if (!opts.yes && process.stdin.isTTY && process.stdout.isTTY) {
        const ok = await confirm(
          `Delete Data Braider endpoint "${code}" and all its configuration?`,
        );
        if (!ok) {
          console.log(pc.dim('Aborted.'));
          return;
        }
      }
      const bc = await braiderFor(globals.profile);
      await bc.deleteEndpoint(code, { company: opts.company });
      console.log(pc.green(`✔ deleted endpoint "${code}"`));
    });
}
