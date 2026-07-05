import type { CachedRouteMetadata, EntitySetInfo } from '@navapi/core';
import type { Command } from 'commander';
import pc from 'picocolors';
import { createClient } from '../context.js';
import { columnize, emitJson, printTable, wantJson } from '../output.js';

interface Match {
  route: string;
  entitySet: EntitySetInfo;
}

/** Route enumeration via the runtime API is company-scoped; without a
 * company only the standard route is discoverable — say so instead of
 * silently returning a short list. */
function warnIfNoCompany(company: string | undefined): void {
  if (!company) {
    console.error(
      pc.yellow(
        'No default company set — custom and Microsoft API routes cannot be enumerated. Run: navapi company use',
      ),
    );
  }
}

function findMatches(cached: CachedRouteMetadata[], term?: string): Match[] {
  const needle = term?.toLowerCase();
  const matches: Match[] = [];
  for (const entry of cached) {
    for (const es of entry.metadata.entitySets) {
      if (!needle || es.name.toLowerCase().includes(needle)) {
        matches.push({ route: entry.routePath, entitySet: es });
      }
    }
  }
  return matches;
}

function printRouteTree(cached: CachedRouteMetadata[], errors: { route: string; error: string }[]) {
  for (const entry of cached) {
    const sets = entry.metadata.entitySets;
    console.log(
      `${pc.bold(pc.cyan(entry.routePath))} ${pc.dim(
        `— ${sets.length} entity sets (fetched ${entry.fetchedAt.slice(0, 10)})`,
      )}`,
    );
    columnize(sets.map((s) => (s.actions.length ? `${s.name}${pc.yellow('*')}` : s.name)));
    console.log();
  }
  if (cached.some((c) => c.metadata.entitySets.some((s) => s.actions.length))) {
    console.log(pc.dim(`${pc.yellow('*')} has bound actions`));
  }
  for (const e of errors) {
    console.log(pc.red(`✘ ${e.route}: ${e.error}`));
  }
}

function printSchema(match: Match): void {
  const es = match.entitySet;
  console.log(
    `${pc.bold(pc.cyan(es.name))} ${pc.dim(`(${es.entityType})`)} on route ${pc.bold(match.route)}`,
  );
  console.log(pc.dim(`keys: ${es.keys.join(', ') || '(none)'}`));
  if (es.actions.length) console.log(pc.dim(`bound actions: ${es.actions.join(', ')}`));
  console.log();
  printTable(
    es.properties.map((p) => ({
      property: p.name,
      type: p.type,
      nullable: p.nullable ? '' : 'required',
      maxLength: p.maxLength ?? '',
    })),
    ['property', 'type', 'nullable', 'maxLength'],
  );
  if (es.navigationProperties.length) {
    console.log();
    console.log(pc.bold('navigation properties'));
    printTable(
      es.navigationProperties.map((n) => ({ name: n.name, type: n.type })),
      ['name', 'type'],
    );
  }
}

export function registerDiscover(program: Command): void {
  program
    .command('discover [term]')
    .description(
      'Ingest $metadata from every API route and browse the result. ' +
        'With a term: search entity sets; add --schema for the full shape.',
    )
    .option('--refresh', 'Refetch metadata even if cached')
    .option('--route <route>', 'Limit to one route (e.g. v2.0 or publisher/group/v1.0)')
    .option('--schema', 'Show the full schema for matching entity sets')
    .option('--json', 'JSON output')
    .action(async (term: string | undefined, opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const client = await createClient(globals.profile);
      warnIfNoCompany(client.profile.company);

      let cached: CachedRouteMetadata[];
      const errors: { route: string; error: string }[] = [];
      if (opts.route) {
        cached = [await client.getMetadata(opts.route, { refresh: opts.refresh })];
      } else {
        const existing = opts.refresh ? [] : await client.cachedMetadata();
        if (existing.length) {
          cached = existing;
        } else {
          const results = await client.discoverAll({ refresh: opts.refresh });
          cached = results.filter((r) => r.metadata).map((r) => r.metadata as CachedRouteMetadata);
          errors.push(
            ...results
              .filter((r) => r.error)
              .map((r) => ({ route: r.route.path, error: r.error as string })),
          );
        }
      }

      if (!term) {
        if (wantJson(opts.json)) {
          emitJson({
            routes: cached.map((c) => ({
              route: c.routePath,
              fetchedAt: c.fetchedAt,
              entitySets: c.metadata.entitySets.map((s) => ({
                name: s.name,
                entityType: s.entityType,
                keys: s.keys,
                actions: s.actions,
              })),
            })),
            errors,
          });
          return;
        }
        printRouteTree(cached, errors);
        return;
      }

      const matches = findMatches(cached, term);
      if (wantJson(opts.json)) {
        emitJson(
          matches.map((m) => ({
            route: m.route,
            ...(opts.schema
              ? m.entitySet
              : { name: m.entitySet.name, entityType: m.entitySet.entityType }),
          })),
        );
        return;
      }
      if (!matches.length) {
        console.log(pc.dim(`No entity sets matching "${term}". Try: navapi discover --refresh`));
        return;
      }
      if (opts.schema) {
        for (const m of matches) printSchema(m);
        return;
      }
      printTable(
        matches.map((m) => ({
          route: m.route,
          entitySet: m.entitySet.name,
          keys: m.entitySet.keys.join(','),
          actions: m.entitySet.actions.join(', '),
        })),
        ['route', 'entitySet', 'keys', 'actions'],
      );
      console.log(pc.dim('\nTip: navapi discover <term> --schema shows fields.'));
    });

  program
    .command('ls [route]')
    .description('Browse the cached collection tree (route → entity sets)')
    .option('--json', 'JSON output')
    .action(async (route: string | undefined, opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const client = await createClient(globals.profile);
      let cached = await client.cachedMetadata();
      if (!cached.length) {
        // Nothing ingested yet — run discovery once, then browse.
        const results = await client.discoverAll();
        cached = results.filter((r) => r.metadata).map((r) => r.metadata as CachedRouteMetadata);
      }
      if (route) cached = cached.filter((c) => c.routePath === route);
      if (wantJson(opts.json)) {
        emitJson(
          cached.map((c) => ({
            route: c.routePath,
            entitySets: c.metadata.entitySets.map((s) => s.name),
          })),
        );
        return;
      }
      printRouteTree(cached, []);
    });

  program
    .command('routes')
    .description('List every API route this environment exposes')
    .option('--json', 'JSON output')
    .action(async (opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const client = await createClient(globals.profile);
      warnIfNoCompany(client.profile.company);
      const routes = await client.listRoutes();
      if (wantJson(opts.json)) {
        emitJson(routes);
        return;
      }
      printTable(
        routes.map((r) => ({
          route: r.path,
          publisher: r.publisher ?? '(standard)',
          group: r.group ?? '',
          version: r.version,
        })),
        ['route', 'publisher', 'group', 'version'],
      );
    });
}
