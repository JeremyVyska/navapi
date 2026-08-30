import path from 'node:path';
import { AzureCliAuth, ClientCredentialsAuth, type TokenProvider } from './auth.js';
import { defaultConfigDir, MetadataCache } from './cache.js';
import { BcClient } from './client.js';
import { NavApiError } from './errors.js';
import { ProfileStore, resolveSecretStore } from './profiles.js';
import type { Credential, ProfileConfig, TargetContext } from './types.js';

export interface CreateClientOptions {
  /** Config directory; defaults to NAVAPI_CONFIG_DIR or ~/.navapi */
  configDir?: string;
  fetch?: typeof globalThis.fetch;
}

/**
 * Assembles a ready-to-use BcClient from a saved profile — the shared entry
 * point for every face (CLI, MCP, VS Code, web UI). Resolution order for the
 * profile: explicit name → NAVAPI_PROFILE → stored default. For the secret:
 * NAVAPI_CLIENT_SECRET → secret store, keyed by the **credential's** name.
 * NAVAPI_AUTHORITY overrides the Entra authority host (sovereign clouds, local
 * test servers). Credentials of type `azureCli` take their token from the az
 * CLI and use no secret.
 */
export async function createClientForProfile(
  profileName?: string,
  opts: CreateClientOptions = {},
): Promise<BcClient> {
  const dir = opts.configDir ?? defaultConfigDir();
  const store = new ProfileStore(dir);
  const { resolvedCredential, ...profile } = await store.resolve(
    profileName ?? process.env.NAVAPI_PROFILE,
  );
  return new BcClient({
    profile,
    auth: await createAuth(resolvedCredential, profile, dir, opts),
    cache: new MetadataCache(path.join(dir, 'cache')),
    fetch: opts.fetch,
  });
}

export interface CreateClientForTargetOptions extends CreateClientOptions {
  /** A saved credential's name, or the credential itself. */
  credential: string | Credential;
  target: TargetContext;
  /**
   * Names this client in cache paths and error messages. Defaults to a label
   * derived from the target, so an unsaved client still caches its metadata
   * somewhere stable rather than colliding with a saved profile's cache.
   */
  name?: string;
  readOnly?: boolean;
}

/**
 * Builds a client from a credential and a target, with no saved profile
 * involved — the same identity pointed at whichever tenant and environment
 * the caller names. A profile is a saved shortcut for this, not the only way
 * in.
 */
export async function createClientForTarget(opts: CreateClientForTargetOptions): Promise<BcClient> {
  const dir = opts.configDir ?? defaultConfigDir();
  const credential =
    typeof opts.credential === 'string'
      ? await new ProfileStore(dir).getCredential(opts.credential)
      : opts.credential;
  const profile: ProfileConfig = {
    ...opts.target,
    name: opts.name ?? targetLabel(opts.target),
    credential: credential.name,
    readOnly: opts.readOnly,
  };
  return new BcClient({
    profile,
    auth: await createAuth(credential, profile, dir, opts),
    cache: new MetadataCache(path.join(dir, 'cache')),
    fetch: opts.fetch,
  });
}

/**
 * A stable cache/display name for an unsaved target. Metadata is per tenant +
 * environment, so two ad-hoc calls at the same environment share a cache
 * rather than refetching $metadata each time.
 */
export function targetLabel(target: TargetContext): string {
  return `${target.tenantId}@${target.environment}`;
}

async function createAuth(
  credential: Credential,
  profile: ProfileConfig,
  dir: string,
  opts: CreateClientOptions,
): Promise<TokenProvider> {
  // Azure CLI auth has no secret to resolve — don't send it down the
  // client-credentials path, which would fail on the missing secret.
  if (credential.type === 'azureCli') {
    return new AzureCliAuth({ tenantId: profile.tenantId, account: credential.account });
  }
  // Client ID first: a credential missing both reads as malformed, and naming
  // the absent client ID says more than asking for a secret to go with it.
  if (!credential.clientId) {
    throw new NavApiError(
      `Credential "${credential.name}" has no client ID. ` +
        `Re-run: navapi credential add ${credential.name} --client-id <id> ...`,
    );
  }
  const secret =
    process.env.NAVAPI_CLIENT_SECRET ??
    (await (await resolveSecretStore(dir)).store.get(credential.name));
  if (!secret) {
    throw new NavApiError(
      `No client secret stored for credential "${credential.name}". ` +
        `Re-run: navapi credential add ${credential.name} --secret <secret> ..., or set NAVAPI_CLIENT_SECRET.`,
    );
  }
  return new ClientCredentialsAuth({
    tenantId: profile.tenantId,
    clientId: credential.clientId,
    clientSecret: secret,
    authorityBase: process.env.NAVAPI_AUTHORITY,
    fetch: opts.fetch,
  });
}

/**
 * How a caller says where to run: a saved profile, or a credential and target
 * named directly, or a profile with any of those overridden.
 */
export interface ClientSelector {
  profile?: string;
  credential?: string;
  tenant?: string;
  environment?: string;
}

/**
 * The one resolution rule every face shares.
 *
 * With no overrides this is the familiar path: the named profile →
 * `NAVAPI_PROFILE` → the stored default. Naming any of credential, tenant, or
 * environment layers *over* that profile rather than replacing it, so pointing
 * a saved setup at one more tenant means naming the tenant and nothing else —
 * the cross-tenant case that used to need a saved profile per tenant. With no
 * profile at all, the three stand on their own.
 */
export async function createClientForSelector(
  selector: ClientSelector = {},
  opts: CreateClientOptions = {},
): Promise<BcClient> {
  const sel: ClientSelector = {
    profile: selector.profile ?? process.env.NAVAPI_PROFILE,
    credential: selector.credential ?? process.env.NAVAPI_CREDENTIAL,
    tenant: selector.tenant ?? process.env.NAVAPI_TENANT,
    environment: selector.environment ?? process.env.NAVAPI_ENVIRONMENT,
  };
  if (!sel.credential && !sel.tenant && !sel.environment) {
    return createClientForProfile(sel.profile, opts);
  }

  const dir = opts.configDir ?? defaultConfigDir();
  // A profile is a source of defaults here, not a requirement: fall back to
  // nothing rather than failing, so the overrides can stand alone.
  const base = await new ProfileStore(dir).resolve(sel.profile).catch(() => undefined);

  const credential = sel.credential ?? base?.resolvedCredential;
  const tenantId = sel.tenant ?? base?.tenantId;
  const environment = sel.environment ?? base?.environment;

  const missing = [
    credential ? undefined : 'credential',
    tenantId ? undefined : 'tenant',
    environment ? undefined : 'environment',
  ].filter((x): x is string => Boolean(x));
  if (!credential || !tenantId || !environment) {
    throw new NavApiError(
      `Not enough to reach an environment: no ${missing.join(', no ')} given, ` +
        'and no profile supplied the rest. Name the missing ones, or pick a profile.',
    );
  }

  return createClientForTarget({
    ...opts,
    credential,
    target: { tenantId, environment, company: base?.company, baseUrl: base?.baseUrl },
    // Keep the guardrail when overriding one field of a read-only profile.
    readOnly: base?.readOnly,
    // Reuse the profile's name only when the target did not actually move,
    // so an ad-hoc tenant cannot land in a saved profile's metadata cache.
    name:
      base && tenantId === base.tenantId && environment === base.environment
        ? base.name
        : undefined,
  });
}
