import path from 'node:path';
import { AzureCliAuth, ClientCredentialsAuth, type TokenProvider } from './auth.js';
import { defaultConfigDir, MetadataCache } from './cache.js';
import { BcClient } from './client.js';
import { NavApiError } from './errors.js';
import { ProfileStore, resolveSecretStore } from './profiles.js';
import type { ProfileConfig } from './types.js';

export interface CreateClientOptions {
  /** Config directory; defaults to NAVAPI_CONFIG_DIR or ~/.navapi */
  configDir?: string;
  fetch?: typeof globalThis.fetch;
}

/**
 * Assembles a ready-to-use BcClient from stored profiles — the shared entry
 * point for every face (CLI, MCP, VS Code). Resolution order for the profile:
 * explicit name → NAVAPI_PROFILE → stored default. For the secret:
 * NAVAPI_CLIENT_SECRET → secret store. NAVAPI_AUTHORITY overrides the Entra
 * authority host (sovereign clouds, local test servers). Profiles with
 * `authType: 'azureCli'` take their token from the az CLI and use no secret.
 */
export async function createClientForProfile(
  profileName?: string,
  opts: CreateClientOptions = {},
): Promise<BcClient> {
  const dir = opts.configDir ?? defaultConfigDir();
  const store = new ProfileStore(dir);
  const profile = await store.get(profileName ?? process.env.NAVAPI_PROFILE);
  return new BcClient({
    profile,
    auth: await createAuth(profile, dir, opts),
    cache: new MetadataCache(path.join(dir, 'cache')),
    fetch: opts.fetch,
  });
}

async function createAuth(
  profile: ProfileConfig,
  dir: string,
  opts: CreateClientOptions,
): Promise<TokenProvider> {
  // Azure CLI auth has no secret to resolve — don't send it down the
  // client-credentials path, which would fail on the missing secret.
  if (profile.authType === 'azureCli') {
    return new AzureCliAuth({ tenantId: profile.tenantId, account: profile.azAccount });
  }
  const secret =
    process.env.NAVAPI_CLIENT_SECRET ??
    (await (await resolveSecretStore(dir)).store.get(profile.name));
  if (!secret) {
    throw new NavApiError(
      `No client secret stored for profile "${profile.name}". ` +
        `Re-run: navapi profile add ${profile.name} ... --secret <secret>, or set NAVAPI_CLIENT_SECRET.`,
    );
  }
  if (!profile.clientId) {
    throw new NavApiError(
      `Profile "${profile.name}" has no client ID. ` +
        `Re-run: navapi profile add ${profile.name} ... --client-id <id>.`,
    );
  }
  return new ClientCredentialsAuth({
    tenantId: profile.tenantId,
    clientId: profile.clientId,
    clientSecret: secret,
    authorityBase: process.env.NAVAPI_AUTHORITY,
    fetch: opts.fetch,
  });
}
