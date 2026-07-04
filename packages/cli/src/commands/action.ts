import { type BatchRequest, NavApiError } from '@navapi/core';
import type { Command } from 'commander';
import pc from 'picocolors';
import { createClient } from '../context.js';
import { readJsonSource } from '../json-input.js';
import { emitJson, printRecord, printTable, wantJson } from '../output.js';

export function registerAction(program: Command): void {
  program
    .command('action <entitySet> <id> <actionName>')
    .description(
      'Invoke a bound action, e.g. navapi action salesOrders <id> shipAndInvoice. ' +
        'Bare names are qualified with the schema namespace (Microsoft.NAV by default).',
    )
    .option('--body <json|file|->', 'Action parameters as JSON')
    .option('--route <route>', 'API route (default v2.0)')
    .option('--company <company>', 'Company override for this call')
    .option('--json', 'JSON output')
    .action(async (entitySet: string, id: string, actionName: string, opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const client = await createClient(globals.profile);
      const parameters = opts.body ? await readJsonSource(opts.body) : undefined;
      const result = await client.callAction(entitySet, id, actionName, {
        route: opts.route,
        company: opts.company,
        parameters,
      });
      if (wantJson(opts.json)) {
        emitJson(result ?? { ok: true });
        return;
      }
      console.log(pc.green(`✔ ${actionName} executed on ${entitySet}(${id})`));
      if (result) printRecord(result);
    });

  program
    .command('batch')
    .description(
      'Run an OData $batch. --body takes {"requests":[...]} or a bare array; ' +
        'request URLs are relative to the route root and may use {company}.',
    )
    .requiredOption('--body <json|file|->', 'Batch requests as JSON')
    .option('--route <route>', 'API route (default v2.0)')
    .option('--company <company>', 'Company used for {company} substitution')
    .option('--json', 'JSON output')
    .action(async (opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const client = await createClient(globals.profile);
      const parsed = await readJsonSource(opts.body);
      const requests = Array.isArray(parsed)
        ? parsed
        : ((parsed as { requests?: unknown }).requests ?? null);
      if (!Array.isArray(requests) || !requests.length) {
        throw new NavApiError('--body must be a non-empty array or {"requests": [...]}');
      }
      const responses = await client.batch(requests as BatchRequest[], {
        route: opts.route,
        company: opts.company,
      });
      const failed = responses.filter((r) => !r.ok);
      if (wantJson(opts.json)) {
        emitJson(responses);
      } else {
        printTable(
          responses.map((r) => ({
            id: r.id,
            status: r.status,
            result: r.ok ? pc.green('ok') : pc.red('failed'),
          })),
          ['id', 'status', 'result'],
        );
        if (failed.length) {
          console.error(pc.red(`${failed.length} of ${responses.length} requests failed.`));
        }
      }
      if (failed.length) process.exitCode = 1;
    });
}
