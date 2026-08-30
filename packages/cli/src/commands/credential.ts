import { type Credential, NavApiError } from '@navapi/core';
import type { Command } from 'commander';
import pc from 'picocolors';
import { profileStore, secretStore } from '../context.js';
import { emitJson, printTable, wantJson } from '../output.js';
import { promptSecret } from '../prompt.js';
import { parseAuthType, pickAzAccount, strayAuthFlags } from './profile.js';

/**
 * `navapi credential` — the reusable half of a connection. A credential is an
 * identity; where it points is a profile's business. One credential can back
 * many profiles, which is the point: one app registration reaching a dozen
 * customer environments needs one secret, not a dozen copies.
 */
export function registerCredential(program: Command): void {
  const credential = program
    .command('credential')
    .description('Manage reusable credentials (identities), independent of tenant or environment');

  credential
    .command('add <name>')
    .description('Add or update a credential')
    .option('--auth <type>', 'Auth strategy: clientSecret (default) or azureCli')
    .option('--client-id <clientId>', 'App registration client ID (client-credentials auth)')
    .option(
      '--az-account <userOrId>',
      'Which az identity to use, if az holds more than one (azureCli auth)',
    )
    .option('--secret <secret>', 'Client secret (omit to be prompted, or set NAVAPI_CLIENT_SECRET)')
    .action(async (name: string, opts) => {
      const authType = opts.auth ? parseAuthType(opts.auth) : 'clientSecret';
      const azureCli = authType === 'azureCli';

      const stray = strayAuthFlags(authType, opts);
      if (stray) {
        throw new NavApiError(
          `${stray.join(' and ')} ${stray.length > 1 ? 'are' : 'is'} not used with --auth ${authType}, ` +
            `and would be dropped. Remove ${stray.length > 1 ? 'them' : 'it'} to save this credential as ${authType}.`,
        );
      }
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
        if (!secret) throw new NavApiError('Empty secret; credential not saved.');
      }

      const record: Credential = azureCli
        ? { name, type: 'azureCli', account: azAccount || undefined }
        : { name, type: 'clientSecret', clientId: opts.clientId };
      await profileStore().upsertCredential(record);

      let how: string;
      if (secret) {
        const { store, backend } = await secretStore();
        await store.set(name, secret);
        how = `secret in ${backend}`;
      } else {
        how = azAccount
          ? `Azure CLI as ${azAccount} — no secret required`
          : 'Azure CLI — no secret required';
      }
      console.log(`${pc.green('✔')} Credential ${pc.bold(name)} saved ${pc.dim(`(${how})`)}`);
      console.log(
        pc.dim(
          `Next: navapi profile add <profile> --credential ${name} --tenant … --environment …`,
        ),
      );
    });

  credential
    .command('list')
    .description('List credentials and the profiles they back')
    .option('--json', 'JSON output')
    .action(async (opts) => {
      const { credentials, profiles } = await profileStore().listAll();
      const rows = credentials.map((c) => ({
        ...c,
        usedBy: profiles.filter((p) => p.credential === c.name).map((p) => p.name),
      }));
      if (wantJson(opts.json)) {
        emitJson(rows);
        return;
      }
      printTable(
        rows.map((c) => ({
          name: c.name,
          auth: c.type === 'azureCli' ? 'Azure CLI' : 'app registration',
          identity:
            c.type === 'azureCli' ? (c.account ?? pc.dim('(active az account)')) : c.clientId,
          'used by': c.usedBy.join(', ') || pc.dim('(unused)'),
        })),
        ['name', 'auth', 'identity', 'used by'],
      );
    });

  credential
    .command('remove <name>')
    .description('Remove a credential (refused while a profile still uses it)')
    .option('--forget-secret', 'Also delete the stored secret')
    .action(async (name: string, opts) => {
      await profileStore().removeCredential(name);
      if (opts.forgetSecret) {
        const { store } = await secretStore();
        await store.delete(name);
      }
      console.log(
        `${pc.green('✔')} Credential ${pc.bold(name)} removed` +
          // An Entra client secret is shown once at creation, so deleting it on
          // a whim would be unrecoverable — say where it still is instead.
          (opts.forgetSecret
            ? pc.dim(' (secret deleted)')
            : pc.dim(`; its secret is kept — remove it with: navapi secrets forget ${name}`)),
      );
    });
}
