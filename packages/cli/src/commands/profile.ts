import path from 'node:path';
import {
  type AzureCliAccount,
  listAzureCliAccounts,
  MetadataCache,
  NavApiError,
} from '@navapi/core';
import type { Command } from 'commander';
import pc from 'picocolors';
import { configDir, createClient, profileStore, secretStore } from '../context.js';
import { emitJson, printTable, wantJson } from '../output.js';
import { ask, promptSecret } from '../prompt.js';

type AuthType = 'clientCredentials' | 'azureCli';

/** Accepts the spellings people actually type: azureCli, azure-cli, az-cli. */
export function parseAuthType(value: string): AuthType {
  const key = value.toLowerCase().replace(/[^a-z]/g, '');
  if (key === 'azurecli' || key === 'azcli' || key === 'az') return 'azureCli';
  if (key === 'clientcredentials' || key === 'clientcredential') return 'clientCredentials';
  throw new NavApiError(
    `Unknown --auth value "${value}". Use clientCredentials (default) or azureCli.`,
  );
}

/** One entry per (identity, tenant), nearest tenant first. */
function rankAccounts(accounts: AzureCliAccount[], tenantId: string): AzureCliAccount[] {
  const inTenant = (a: AzureCliAccount) => a.tenantId.toLowerCase() === tenantId.toLowerCase();
  return [...new Map(accounts.map((a) => [`${a.user}|${a.tenantId}`, a])).values()].sort(
    (a, b) => Number(inTenant(b)) - Number(inTenant(a)) || a.user.localeCompare(b.user),
  );
}

/**
 * Offers the az identities to choose from, since nobody remembers which
 * accounts they have connected. Only asks when the answer isn't obvious:
 * one identity needs no question, and az being absent isn't a reason to
 * fail `profile add`.
 */
async function pickAzAccount(tenantId: string): Promise<string | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  let accounts: AzureCliAccount[];
  try {
    accounts = rankAccounts(await listAzureCliAccounts(), tenantId);
  } catch {
    return undefined;
  }
  if (accounts.length < 2) return undefined;

  console.log(pc.dim('az is signed in as more than one identity:'));
  console.log(`${pc.bold(' 0')}) ${pc.dim('whichever account az is signed in as (default)')}`);
  accounts.forEach((a, i) => {
    const where =
      a.tenantId.toLowerCase() === tenantId.toLowerCase()
        ? '— this tenant'
        : `— tenant ${a.tenantId}`;
    console.log(`${pc.bold(String(i + 1).padStart(2))}) ${a.user} ${pc.dim(where)}`);
  });
  const answer = await ask(`Select identity [0-${accounts.length}]: `);
  if (!answer || answer === '0') return undefined;
  const picked = accounts[Number.parseInt(answer, 10) - 1];
  if (!picked) throw new NavApiError(`No identity at position "${answer}".`);
  return picked.user;
}

export function registerProfile(program: Command): void {
  const profile = program
    .command('profile')
    .alias('env')
    .description('Manage environment profiles (one profile = one BC environment)');

  profile
    .command('add <name>')
    .description('Add or update a profile pinned to a BC environment')
    .requiredOption('--tenant <tenantId>', 'Entra ID tenant ID or domain')
    .requiredOption('--environment <environment>', 'BC environment name (e.g. Production)')
    .option('--auth <type>', 'Auth strategy: clientCredentials (default) or azureCli')
    .option('--client-id <clientId>', 'App registration client ID (client-credentials auth)')
    .option(
      '--az-account <userOrId>',
      'Which az identity to use, if az holds more than one (azureCli auth)',
    )
    .option('--company <company>', 'Default company (name, displayName, or GUID)')
    .option('--secret <secret>', 'Client secret (omit to be prompted, or set NAVAPI_CLIENT_SECRET)')
    .option('--base-url <url>', 'Override the BC API host')
    .option('--default', 'Make this the default profile')
    .action(async (name: string, opts) => {
      const authType = opts.auth ? parseAuthType(opts.auth) : 'clientCredentials';
      const azureCli = authType === 'azureCli';

      // Commander can't make --client-id conditionally required, so it's an
      // optional flag the client-credentials path enforces by hand.
      if (!azureCli && !opts.clientId) {
        throw new NavApiError(
          "required option '--client-id <clientId>' not specified " +
            '(or use --auth azureCli, which needs no app registration).',
        );
      }

      const azAccount =
        azureCli && !opts.azAccount ? await pickAzAccount(opts.tenant) : opts.azAccount;

      let secret: string | undefined;
      if (!azureCli) {
        secret = opts.secret ?? process.env.NAVAPI_CLIENT_SECRET ?? undefined;
        if (!secret) {
          if (!process.stdin.isTTY) {
            throw new NavApiError(
              'No secret provided. Use --secret or the NAVAPI_CLIENT_SECRET env var.',
            );
          }
          secret = await promptSecret(`Client secret for ${name}: `);
        }
        if (!secret) throw new NavApiError('Empty secret; profile not saved.');
      }

      await profileStore().upsert(
        {
          name,
          tenantId: opts.tenant,
          authType,
          clientId: azureCli ? undefined : opts.clientId,
          azAccount: azureCli ? azAccount : undefined,
          environment: opts.environment,
          company: opts.company,
          baseUrl: opts.baseUrl,
        },
        { makeDefault: Boolean(opts.default) },
      );
      let how: string;
      if (secret) {
        const { store, backend } = await secretStore();
        await store.set(name, secret);
        how = `secret in ${backend}`;
      } else {
        how = azAccount
          ? `auth: Azure CLI as ${azAccount} — no secret stored`
          : 'auth: Azure CLI — no secret stored';
      }
      console.log(
        `${pc.green('✔')} Profile ${pc.bold(name)} saved ` +
          pc.dim(`(${opts.environment} @ ${opts.tenant}, ${how})`),
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
    .command('az-accounts')
    .description('List the identities az is signed in as, for --az-account')
    .option('--json', 'JSON output')
    .action(async (opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const accounts = await listAzureCliAccounts();
      if (wantJson(opts.json)) {
        emitJson(accounts);
        return;
      }
      if (!accounts.length) {
        console.log(pc.dim('az is not signed in to any account. Run: az login'));
        return;
      }
      // Rank against the named profile's tenant when there is one to compare to.
      let tenantId = '';
      try {
        tenantId = (await profileStore().get(globals.profile)).tenantId;
      } catch {
        // no profile yet, or none named — plain alphabetical is fine
      }
      printTable(
        rankAccounts(accounts, tenantId).map((a) => ({
          identity: a.user,
          tenant: a.tenantId,
          '': a.tenantId.toLowerCase() === tenantId.toLowerCase() ? '● this tenant' : '',
        })),
        ['identity', 'tenant', ''],
      );
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
