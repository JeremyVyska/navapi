import {
  FileSecretStore,
  KeychainSecretStore,
  loadKeyringFactory,
  secretServiceAvailable,
} from '@navapi/core';
import type { Command } from 'commander';
import pc from 'picocolors';
import { configDir, profileStore, secretStore } from '../context.js';
import { emitJson, printTable, wantJson } from '../output.js';

interface SecretLocation {
  profile: string;
  /** False for az-cli profiles, which authenticate without a stored secret. */
  secretRequired: boolean;
  keychain: boolean;
  file: boolean;
}

async function locateSecrets(): Promise<{ keychainAvailable: boolean; rows: SecretLocation[] }> {
  const { profiles } = await profileStore().listAll();
  const file = new FileSecretStore(configDir());
  const factory = await loadKeyringFactory();
  const usable = factory && secretServiceAvailable();
  const keychain = usable ? new KeychainSecretStore(factory) : undefined;
  const rows: SecretLocation[] = [];
  for (const p of profiles) {
    rows.push({
      profile: p.name,
      secretRequired: p.auth.type !== 'azureCli',
      keychain: keychain ? (await keychain.get(p.name)) !== undefined : false,
      file: (await file.get(p.name)) !== undefined,
    });
  }
  return { keychainAvailable: Boolean(keychain), rows };
}

export function registerSecrets(program: Command): void {
  const secrets = program
    .command('secrets')
    .description('Inspect and manage where profile secrets are stored');

  secrets
    .command('status')
    .description('Show the active backend and where each profile secret lives')
    .option('--json', 'JSON output')
    .action(async (opts) => {
      const { keychainAvailable, rows } = await locateSecrets();
      // Say which of the reasons applies, so "file" doesn't look like a
      // failure when it is the deliberate choice on a session with no
      // Secret Service to store anything durably in.
      let backend: string;
      if (process.env.NAVAPI_SECRET_BACKEND === 'file') {
        backend = 'file (forced via NAVAPI_SECRET_BACKEND)';
      } else if (!secretServiceAvailable()) {
        backend = 'file (no Secret Service on this session — the keychain would not persist here)';
      } else if (keychainAvailable) {
        backend = 'keychain (file fallback)';
      } else {
        backend = 'file (no keychain available)';
      }
      if (wantJson(opts.json)) {
        emitJson({ backend, keychainAvailable, secrets: rows });
        return;
      }
      console.log(`Backend: ${pc.bold(backend)}`);
      printTable(
        rows.map((r) => ({
          profile: r.profile,
          auth: r.secretRequired ? 'app registration' : 'Azure CLI',
          // An az-cli profile has nothing stored anywhere, which would
          // otherwise read as a secret that has gone missing.
          keychain: r.keychain ? '✔' : r.secretRequired ? '' : pc.dim('no secret required'),
          'plaintext file': r.file ? pc.yellow('⚠ yes') : '',
        })),
        ['profile', 'auth', 'keychain', 'plaintext file'],
      );
      if (rows.some((r) => r.file) && keychainAvailable) {
        console.log(pc.dim('Run "navapi secrets migrate" to move file secrets into the keychain.'));
      }
    });

  secrets
    .command('forget <profile>')
    .description('Delete a stored secret without removing the profile')
    .action(async (name: string) => {
      const { store } = await secretStore();
      if ((await store.get(name)) === undefined) {
        console.log(pc.dim(`No secret stored for ${name}.`));
        return;
      }
      await store.delete(name);
      console.log(`${pc.green('✔')} Removed the stored secret for ${pc.bold(name)}`);
    });

  secrets
    .command('migrate')
    .description('Move any plaintext file secrets into the OS keychain')
    .option('--json', 'JSON output')
    .action(async (opts) => {
      const factory = await loadKeyringFactory();
      if (!factory) {
        throw new Error(
          'No OS keychain available on this system (is @napi-rs/keyring installed?).',
        );
      }
      const file = new FileSecretStore(configDir());
      const keychain = new KeychainSecretStore(factory);
      const { profiles } = await profileStore().listAll();
      const migrated: string[] = [];
      for (const p of profiles) {
        const secret = await file.get(p.name);
        if (secret === undefined) continue;
        await keychain.set(p.name, secret);
        await file.delete(p.name);
        migrated.push(p.name);
      }
      if (wantJson(opts.json)) {
        emitJson({ migrated });
        return;
      }
      if (!migrated.length) {
        console.log(pc.dim('Nothing to migrate — no plaintext file secrets found.'));
        return;
      }
      console.log(
        `${pc.green('✔')} Moved ${migrated.length} secret(s) into the keychain: ${migrated.join(', ')}`,
      );
    });
}
