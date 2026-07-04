import path from 'node:path';
import { MetadataCache, NavApiError } from '@navapi/core';
import type { Command } from 'commander';
import pc from 'picocolors';
import { configDir, createClient, profileStore, secretStore } from '../context.js';
import { emitJson, printTable, wantJson } from '../output.js';
import { promptSecret } from '../prompt.js';

export function registerProfile(program: Command): void {
  const profile = program
    .command('profile')
    .alias('env')
    .description('Manage environment profiles (one profile = one BC environment)');

  profile
    .command('add <name>')
    .description('Add or update a profile pinned to a BC environment')
    .requiredOption('--tenant <tenantId>', 'Entra ID tenant ID or domain')
    .requiredOption('--client-id <clientId>', 'App registration client ID')
    .requiredOption('--environment <environment>', 'BC environment name (e.g. Production)')
    .option('--company <company>', 'Default company (name, displayName, or GUID)')
    .option('--secret <secret>', 'Client secret (omit to be prompted, or set NAVAPI_CLIENT_SECRET)')
    .option('--base-url <url>', 'Override the BC API host')
    .option('--default', 'Make this the default profile')
    .action(async (name: string, opts) => {
      let secret: string | undefined = opts.secret ?? process.env.NAVAPI_CLIENT_SECRET ?? undefined;
      if (!secret) {
        if (!process.stdin.isTTY) {
          throw new NavApiError(
            'No secret provided. Use --secret or the NAVAPI_CLIENT_SECRET env var.',
          );
        }
        secret = await promptSecret(`Client secret for ${name}: `);
      }
      if (!secret) throw new NavApiError('Empty secret; profile not saved.');

      await profileStore().upsert(
        {
          name,
          tenantId: opts.tenant,
          clientId: opts.clientId,
          environment: opts.environment,
          company: opts.company,
          baseUrl: opts.baseUrl,
        },
        { makeDefault: Boolean(opts.default) },
      );
      const { store, backend } = await secretStore();
      await store.set(name, secret);
      console.log(
        `${pc.green('✔')} Profile ${pc.bold(name)} saved ` +
          pc.dim(`(${opts.environment} @ ${opts.tenant}, secret in ${backend})`),
      );
      console.log(pc.dim(`Next: navapi discover -p ${name}`));
    });

  profile
    .command('list')
    .description('List profiles')
    .option('--json', 'JSON output')
    .action(async (opts) => {
      const { profiles, defaultProfile } = await profileStore().listAll();
      if (wantJson(opts.json)) {
        emitJson({ profiles, defaultProfile });
        return;
      }
      printTable(
        profiles.map((p) => ({
          '': p.name === defaultProfile ? '*' : '',
          name: p.name,
          environment: p.environment,
          tenant: p.tenantId,
          company: p.company ?? '',
        })),
        ['', 'name', 'environment', 'tenant', 'company'],
      );
    });

  profile
    .command('test [name]')
    .description('Verify credentials: request a token and list companies')
    .option('--json', 'JSON output')
    .action(async (name: string | undefined, opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const client = await createClient(name ?? globals.profile);
      try {
        const companies = await client.listCompanies();
        if (wantJson(opts.json)) {
          emitJson({
            ok: true,
            profile: client.profile.name,
            environment: client.profile.environment,
            companies: companies.length,
          });
          return;
        }
        console.log(
          `${pc.green('✔')} Connected to ${pc.bold(client.profile.environment)} as ${pc.bold(
            client.profile.name,
          )} ${pc.dim(`— ${companies.length} ${companies.length === 1 ? 'company' : 'companies'} visible`)}`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (wantJson(opts.json)) {
          emitJson({ ok: false, profile: client.profile.name, error: message });
          process.exitCode = 1;
          return;
        }
        throw new NavApiError(`Connection test failed for "${client.profile.name}": ${message}`);
      }
    });

  profile
    .command('use <name>')
    .description('Set the default profile')
    .action(async (name: string) => {
      await profileStore().setDefault(name);
      console.log(`${pc.green('✔')} Default profile is now ${pc.bold(name)}`);
    });

  profile
    .command('remove <name>')
    .description('Remove a profile, its secret, and its metadata cache')
    .action(async (name: string) => {
      await profileStore().remove(name);
      await (await secretStore()).store.delete(name);
      await new MetadataCache(path.join(configDir(), 'cache')).clear(name);
      console.log(`${pc.green('✔')} Removed profile ${pc.bold(name)}`);
    });
}
