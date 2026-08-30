import path from 'node:path';
import {
  activeAzureCliAccount,
  listAzureCliAccounts,
  MetadataCache,
  NavApiError,
} from '@navapi/core';
import type { Command } from 'commander';
import pc from 'picocolors';
import { configDir, createClient, profileStore, secretStore } from '../context.js';
import { emitJson, printTable, wantJson } from '../output.js';
import { ask, promptSecret } from '../prompt.js';

type AuthType = 'clientSecret' | 'azureCli';

/**
 * Accepts the spellings people actually type. `clientSecret` rather than
 * `clientCredentials` because a certificate uses the client-credentials grant
 * too — the distinction that matters here is which credential, not which
 * grant. `clientCredentials` stays accepted as an alias.
 */
export function parseAuthType(value: string): AuthType {
  const key = value.toLowerCase().replace(/[^a-z]/g, '');
  if (key === 'azurecli' || key === 'azcli' || key === 'az') return 'azureCli';
  if (key === 'clientsecret' || key === 'secret') return 'clientSecret';
  if (key === 'clientcredentials' || key === 'clientcredential') return 'clientSecret';
  throw new NavApiError(`Unknown --auth value "${value}". Use clientSecret (default) or azureCli.`);
}

const FLAG_NAMES: Record<string, string> = {
  clientId: '--client-id',
  secret: '--secret',
  azAccount: '--az-account',
};

/**
 * Flags belonging to the other strategy are dropped on save rather than
 * applied, which is worth an error and not silence: appending `--auth
 * azureCli` to an existing `profile add` command would otherwise discard the
 * client ID, leaving the retained client secret with nothing to pair it with.
 */
export function strayAuthFlags(
  authType: AuthType,
  opts: Record<string, unknown>,
): string[] | undefined {
  const irrelevant = authType === 'azureCli' ? ['clientId', 'secret'] : ['azAccount'];
  const stray = irrelevant.filter((flag) => opts[flag]).map((flag) => FLAG_NAMES[flag]);
  return stray.length ? stray : undefined;
}

export interface AzIdentity {
  user: string;
  /** Tenants az holds an account in. An identity can reach others besides these. */
  tenants: string[];
  /** The account az is signed in as — the only one usable for a tenant it has no account in. */
  current: boolean;
}

/**
 * What `--az-account` selects is an identity, not one tenant's account: the
 * same identity often reaches tenants az holds no account in, through
 * delegated admin or a guest invite. So collapse az's accounts by username.
 */
async function azIdentities(): Promise<AzIdentity[]> {
  const [accounts, active] = await Promise.all([
    listAzureCliAccounts(),
    // An unusable active account — an expired refresh token, a transient az
    // error — costs only the "signed in now" marker. It must not hide the
    // identities az does know, or profile add would save an unpinned profile.
    activeAzureCliAccount().catch(() => undefined),
  ]);
  const byUser = new Map<string, AzIdentity>();
  const seed = (user: string): AzIdentity => {
    const existing = byUser.get(user);
    if (existing) return existing;
    const created: AzIdentity = { user, tenants: [], current: false };
    byUser.set(user, created);
    return created;
  };
  for (const a of accounts) {
    const entry = seed(a.user);
    if (!entry.tenants.includes(a.tenantId)) entry.tenants.push(a.tenantId);
  }
  if (active) seed(active.user).current = true;
  return [...byUser.values()].sort(
    (a, b) => Number(b.current) - Number(a.current) || a.user.localeCompare(b.user),
  );
}

/**
 * Resolves which az identity the profile should pin.
 *
 * Pinning is the default even when there is only one identity: leaving it
 * unpinned means a later `az login` as somebody else silently changes who the
 * profile authenticates as, which is the thing the resolution code goes out of
 * its way to prevent once an identity *is* pinned. One identity needs no
 * question, so it is pinned without asking; more than one is a real choice.
 * Option 0 stays available for deliberately following whichever identity az is
 * signed in as.
 *
 * az being absent or signed out is not a reason to fail `profile add` — the
 * profile is simply saved unpinned.
 */
export function resolveIdentityChoice(
  identities: AzIdentity[],
  canPrompt: boolean,
): { pin?: string; prompt: boolean } {
  if (!identities.length) return { prompt: false };
  if (identities.length === 1) return { pin: identities[0].user, prompt: false };
  return { prompt: canPrompt };
}

export async function pickAzAccount(): Promise<string | undefined> {
  let identities: AzIdentity[];
  try {
    identities = await azIdentities();
  } catch {
    return undefined;
  }
  const canPrompt = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const choice = resolveIdentityChoice(identities, canPrompt);
  if (!choice.prompt) return choice.pin;

  console.log(pc.dim('az is signed in as more than one identity:'));
  console.log(
    `${pc.bold(' 0')}) ${pc.dim('do not pin — follow whichever identity az is signed in as')}`,
  );
  identities.forEach((a, i) => {
    const mark = a.current ? pc.dim('— signed in now') : '';
    console.log(`${pc.bold(String(i + 1).padStart(2))}) ${a.user} ${mark}`);
  });
  const answer = await ask(`Select identity [0-${identities.length}]: `);
  if (!answer || answer === '0') return undefined;
  const picked = identities[Number.parseInt(answer, 10) - 1];
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
    .option(
      '--credential <name>',
      'Use an existing saved credential instead of creating one for this profile',
    )
    .option('--auth <type>', 'Auth strategy: clientSecret (default) or azureCli')
    .option('--client-id <clientId>', 'App registration client ID (client-credentials auth)')
    .option(
      '--az-account <userOrId>',
      'Which az identity to use, if az holds more than one (azureCli auth)',
    )
    .option('--company <company>', 'Default company (name, displayName, or GUID)')
    .option('--secret <secret>', 'Client secret (omit to be prompted, or set NAVAPI_CLIENT_SECRET)')
    .option('--base-url <url>', 'Override the BC API host')
    .option(
      '--read-only',
      'Refuse every write through this profile (guardrail against accidental ' +
        'writes, not a security boundary — use a read-only BC permission set for that)',
    )
    .option('--default', 'Make this the default profile')
    .action(async (name: string, opts) => {
      // Pointing at a saved credential is the whole reason credentials exist:
      // one identity, many environments, one secret.
      if (opts.credential) {
        const stray = ['clientId', 'secret', 'azAccount', 'auth'].filter((k) => opts[k]);
        if (stray.length) {
          throw new NavApiError(
            `--credential names an existing credential, so ${stray
              .map((k) => `--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`)
              .join(' and ')} would be ignored. ` +
              `Change the credential itself with: navapi credential add ${opts.credential} ...`,
          );
        }
        const credential = await profileStore().getCredential(opts.credential);
        await profileStore().upsert(
          {
            name,
            credential: credential.name,
            tenantId: opts.tenant,
            environment: opts.environment,
            company: opts.company,
            baseUrl: opts.baseUrl,
            readOnly: opts.readOnly ? true : undefined,
          },
          { makeDefault: Boolean(opts.default) },
        );
        console.log(
          `${pc.green('✔')} Profile ${pc.bold(name)} saved ` +
            pc.dim(`(${opts.environment} @ ${opts.tenant}, credential: ${credential.name})`),
        );
        console.log(pc.dim(`Next: navapi discover -p ${name}`));
        return;
      }

      const authType = opts.auth ? parseAuthType(opts.auth) : 'clientSecret';
      const azureCli = authType === 'azureCli';

      const stray = strayAuthFlags(authType, opts);
      if (stray) {
        throw new NavApiError(
          `${stray.join(' and ')} ${stray.length > 1 ? 'are' : 'is'} not used with --auth ${authType}, ` +
            `and would be dropped. Remove ${stray.length > 1 ? 'them' : 'it'} to save this profile as ${authType}.`,
        );
      }

      // Commander can't make --client-id conditionally required, so it's an
      // optional flag the client-credentials path enforces by hand.
      if (!azureCli && !opts.clientId) {
        throw new NavApiError(
          "required option '--client-id <clientId>' not specified " +
            '(or use --auth azureCli, which needs no app registration).',
        );
      }

      const azAccount = azureCli && !opts.azAccount ? await pickAzAccount() : opts.azAccount;

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

      // Whether this replaces a secret-backed profile decides if there is a
      // now-unused secret to clear out below.
      const replaced = await profileStore()
        .resolve(name)
        .catch(() => undefined);

      // The minted credential takes the profile's name. That keeps a secret
      // already stored under this name resolving, and matches how migrated
      // profiles are named, so the two paths agree.
      await profileStore().upsertWithCredential(
        {
          name,
          tenantId: opts.tenant,
          environment: opts.environment,
          company: opts.company,
          baseUrl: opts.baseUrl,
          readOnly: opts.readOnly ? true : undefined,
        },
        azureCli
          ? { name, type: 'azureCli', account: azAccount || undefined }
          : { name, type: 'clientSecret', clientId: opts.clientId },
        { makeDefault: Boolean(opts.default) },
      );

      let how: string;
      if (secret) {
        const { store, backend } = await secretStore();
        await store.set(name, secret);
        how = `secret in ${backend}`;
      } else {
        // "required", not "stored": the mode is what has no secret. A profile
        // switched over from a client secret still has one sitting in the store.
        how = azAccount
          ? `auth: Azure CLI as ${azAccount} — no secret required`
          : 'auth: Azure CLI — no secret required';
        // Switching away from a secret leaves one behind that nothing uses.
        // Say so rather than reporting "no secret stored" while one sits in
        // the keychain — but don't delete it: an Entra client secret is shown
        // once at creation, so a mistaken switch would be unrecoverable.
        if (replaced?.resolvedCredential.type === 'clientSecret') {
          const { store } = await secretStore();
          if ((await store.get(name)) !== undefined) {
            how += `; the previous client secret is kept — remove it with: navapi secrets forget ${name}`;
          }
        }
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
      const { profiles, credentials, defaultProfile } = await profileStore().listAll();
      if (wantJson(opts.json)) {
        emitJson({ profiles, credentials, defaultProfile });
        return;
      }
      printTable(
        profiles.map((p) => ({
          '': p.name === defaultProfile ? '*' : '',
          name: p.name,
          environment: p.environment,
          tenant: p.tenantId,
          company: p.company ?? '',
          credential: p.credential,
          access: p.readOnly ? pc.yellow('read-only') : '',
        })),
        ['', 'name', 'environment', 'tenant', 'company', 'credential', 'access'],
      );
    });

  profile
    .command('test [name]')
    .description('Verify credentials: request a token and list companies')
    .option('--json', 'JSON output')
    .action(async (name: string | undefined, opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const client = await createClient({ ...globals, profile: name ?? globals.profile });
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
    .action(async (opts) => {
      const identities = await azIdentities();
      if (wantJson(opts.json)) {
        emitJson(identities);
        return;
      }
      if (!identities.length) {
        console.log(pc.dim('az is not signed in to any account. Run: az login'));
        return;
      }
      printTable(
        identities.map((a) => ({
          '': a.current ? '●' : '',
          identity: a.user,
          'tenants az has an account in': a.tenants.join(', '),
        })),
        ['', 'identity', 'tenants az has an account in'],
      );
      console.log(
        pc.dim(
          '● is the identity az is signed in as. An identity can also reach tenants it has\n' +
            'no account in, through delegated admin or a guest invite — but only while it is\n' +
            'the one signed in.',
        ),
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
