import { formatKey, NavApiError, type ODataQuery } from '@navapi/core';
import type { Command } from 'commander';
import pc from 'picocolors';
import { createClient } from '../context.js';
import { readJsonSource as readBody } from '../json-input.js';
import { emitJson, printRecord, printTable, wantJson } from '../output.js';
import { confirm } from '../prompt.js';

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function csv(value?: string): string[] | undefined {
  return value
    ? value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
}

/** `--set key=value` pairs → object; values parse as JSON when possible. */
export function parseSetArgs(pairs: string[]): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      throw new NavApiError(`Invalid --set "${pair}"; expected key=value`);
    }
    const key = pair.slice(0, eq);
    const raw = pair.slice(eq + 1);
    try {
      body[key] = JSON.parse(raw);
    } catch {
      body[key] = raw;
    }
  }
  return body;
}

export function registerCrud(program: Command): void {
  program
    .command('get <entitySet> [id]')
    .description('List records, fetch one by ID, or fetch a navigation property')
    .option('--filter <odata>', 'OData $filter, e.g. "status eq \'Open\'"')
    .option('--select <fields>', 'Comma-separated $select')
    .option('--expand <navProps>', 'Comma-separated $expand')
    .option('--orderby <fields>', 'Comma-separated $orderby')
    .option('--top <n>', 'Limit result count', Number)
    .option('--skip <n>', '$skip offset', Number)
    .option('--all', 'Follow pagination to the end')
    .option('--nav <navProperty>', 'Fetch a navigation property of the record (requires an id)')
    .option('--count', 'Request $count and report the total matching records')
    .option('--show-url', 'Print the request URL to stderr (copy/paste-able)')
    .option('--route <route>', 'API route (default v2.0)')
    .option('--company <company>', 'Company override for this call')
    .option('--json', 'JSON output')
    .action(async (entitySet: string, id: string | undefined, opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const client = await createClient(globals.profile);
      const scope = { route: opts.route, company: opts.company };

      if (opts.nav && !id) throw new NavApiError('--nav requires a record id.');

      if (id) {
        if (opts.showUrl) {
          const base = await client.buildListUrl(entitySet, scope);
          console.error(pc.dim(`${base}(${formatKey(id)})${opts.nav ? `/${opts.nav}` : ''}`));
        }
        if (opts.nav) {
          const nav = await client.getNavigation(entitySet, id, opts.nav, scope);
          if (nav.kind === 'record') {
            const record = nav.items[0];
            if (!record) console.error(pc.dim('(empty)'));
            if (wantJson(opts.json)) emitJson(record ?? null);
            else if (record) printRecord(record);
            return;
          }
          if (wantJson(opts.json)) emitJson(nav.items);
          else printTable(nav.items);
          return;
        }
        const record = await client.getRecord(entitySet, id, scope);
        if (wantJson(opts.json)) emitJson(record);
        else printRecord(record);
        return;
      }

      const query: ODataQuery = {
        filter: opts.filter,
        select: csv(opts.select),
        expand: csv(opts.expand),
        orderby: csv(opts.orderby),
        top: opts.top,
        skip: opts.skip,
        count: Boolean(opts.count),
      };
      if (opts.showUrl) {
        console.error(pc.dim(await client.buildListUrl(entitySet, { ...scope, query })));
      }
      const result = await client.list(entitySet, { ...scope, query, all: opts.all });
      if (wantJson(opts.json)) {
        // The bare-array shape stays stable; --count opts into an envelope.
        if (opts.count) emitJson({ count: result.count, items: result.items });
        else emitJson(result.items);
      } else {
        printTable(result.items);
        if (opts.count && result.count !== undefined) {
          console.error(
            pc.dim(
              `Showing ${result.items.length} of ${result.count.toLocaleString('en-US')} records.`,
            ),
          );
        }
      }
      if (result.nextLink) {
        console.error(pc.dim('More records available — add --all to fetch every page.'));
      }
    });

  program
    .command('post <entitySet>')
    .description('Create a record')
    .requiredOption('--body <json|file|->', 'Inline JSON, a file path, or - for stdin')
    .option('--route <route>', 'API route (default v2.0)')
    .option('--company <company>', 'Company override for this call')
    .option('--json', 'JSON output')
    .action(async (entitySet: string, opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const client = await createClient(globals.profile);
      const body = await readBody(opts.body);
      const created = await client.create(entitySet, body, {
        route: opts.route,
        company: opts.company,
      });
      if (wantJson(opts.json)) emitJson(created);
      else {
        console.log(pc.green('✔ created'));
        printRecord(created);
      }
    });

  program
    .command('patch <entitySet> <id>')
    .description('Update a record (ETags handled automatically)')
    .option('--set <key=value>', 'Field to set; repeatable', collect, [])
    .option('--body <json|file|->', 'Inline JSON, a file path, or - for stdin')
    .option('--route <route>', 'API route (default v2.0)')
    .option('--company <company>', 'Company override for this call')
    .option('--json', 'JSON output')
    .action(async (entitySet: string, id: string, opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const client = await createClient(globals.profile);
      const fromBody = opts.body ? await readBody(opts.body) : {};
      if (typeof fromBody !== 'object' || fromBody === null || Array.isArray(fromBody)) {
        throw new NavApiError('--body must be a JSON object for patch');
      }
      const patch = { ...(fromBody as Record<string, unknown>), ...parseSetArgs(opts.set) };
      if (!Object.keys(patch).length) {
        throw new NavApiError('Nothing to update. Use --set key=value or --body.');
      }
      const updated = await client.update(entitySet, id, patch, {
        route: opts.route,
        company: opts.company,
      });
      if (wantJson(opts.json)) emitJson(updated);
      else {
        console.log(pc.green('✔ updated'));
        printRecord(updated);
      }
    });

  program
    .command('delete <entitySet> <id>')
    .description('Delete a record (ETags handled automatically)')
    .option('--yes', 'Skip confirmation')
    .option('--route <route>', 'API route (default v2.0)')
    .option('--company <company>', 'Company override for this call')
    .action(async (entitySet: string, id: string, opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      if (!opts.yes && process.stdin.isTTY && process.stdout.isTTY) {
        const ok = await confirm(`Delete ${entitySet}(${id})?`);
        if (!ok) {
          console.log(pc.dim('Aborted.'));
          return;
        }
      }
      const client = await createClient(globals.profile);
      await client.deleteRecord(entitySet, id, { route: opts.route, company: opts.company });
      console.log(pc.green(`✔ deleted ${entitySet}(${id})`));
    });

  program
    .command('companies')
    .description('List companies in the environment')
    .option('--json', 'JSON output')
    .action(async (opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const client = await createClient(globals.profile);
      const companies = await client.listCompanies();
      if (wantJson(opts.json)) emitJson(companies);
      else printTable(companies, ['name', 'displayName', 'id']);
    });
}
