import { NavApiError } from './errors.js';
import type { Credential, ProfileConfig } from './types.js';

/**
 * Version of the exchange format, independent of any package version. Bump it
 * only when the shape changes in a way an older navapi could misread; adding an
 * optional field is not that.
 */
export const PORTABLE_VERSION = 1;

/**
 * A portable set of profiles and the credentials they use.
 *
 * **Never contains a secret**, whatever backend the exporting machine used.
 * That is the whole contract: a file in this format is safe to commit, paste
 * into a ticket, or hand to a colleague. Each person supplies their own secret
 * on the receiving end.
 */
export interface PortableConfig {
  version: number;
  credentials: Credential[];
  profiles: ProfileConfig[];
}

/**
 * An az CLI credential's `account` pins a specific human identity. It is
 * correct on the machine that wrote it and wrong everywhere else — a colleague
 * importing it would have their profile pinned to *your* login, which cannot
 * work for them. Export the credential without it so each person's own `az
 * login` applies.
 */
function portableCredential(credential: Credential): Credential {
  if (credential.type !== 'azureCli') return credential;
  const { account: _pinned, ...rest } = credential;
  return rest;
}

export interface ExportOptions {
  /** Limit to these profile names; omit for all of them. */
  names?: string[];
}

/**
 * Builds an export from the store's contents. Only the credentials the exported
 * profiles actually reference come along — exporting one profile should not
 * disclose the rest of someone's estate.
 */
export function buildPortableConfig(
  profiles: ProfileConfig[],
  credentials: Credential[],
  opts: ExportOptions = {},
): PortableConfig {
  let selected = profiles;
  if (opts.names?.length) {
    const wanted = new Set(opts.names);
    selected = profiles.filter((p) => wanted.has(p.name));
    const missing = opts.names.filter((n) => !profiles.some((p) => p.name === n));
    if (missing.length) {
      throw new NavApiError(
        `No such profile: ${missing.join(', ')}. Known profiles: ${
          profiles.map((p) => p.name).join(', ') || '(none)'
        }`,
      );
    }
  }
  const used = new Set(selected.map((p) => p.credential));
  return {
    version: PORTABLE_VERSION,
    credentials: credentials.filter((c) => used.has(c.name)).map(portableCredential),
    profiles: selected,
  };
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new NavApiError(`${what} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new NavApiError(`${what} is required.`);
  }
  return value;
}

/**
 * Parses and validates an exported file. Rejects anything carrying a secret
 * rather than quietly dropping it: a file with a secret in it has already been
 * mishandled, and saying so is more useful than silently accepting it.
 */
export function parsePortableConfig(raw: unknown): PortableConfig {
  const doc = asRecord(raw, 'An exported config');
  const version = typeof doc.version === 'number' ? doc.version : undefined;
  if (version === undefined) {
    throw new NavApiError('An exported config needs a "version" field.');
  }
  if (version > PORTABLE_VERSION) {
    throw new NavApiError(
      `This file is version ${version}, but this navapi understands up to ${PORTABLE_VERSION}. Upgrade navapi to import it.`,
    );
  }
  if (!Array.isArray(doc.profiles)) {
    throw new NavApiError('An exported config needs a "profiles" array.');
  }
  const rawCredentials = Array.isArray(doc.credentials) ? doc.credentials : [];

  const credentials: Credential[] = rawCredentials.map((entry, i) => {
    const c = asRecord(entry, `credentials[${i}]`);
    if ('clientSecret' in c || 'secret' in c || 'password' in c) {
      throw new NavApiError(
        `credentials[${i}] carries a secret. Exports never contain secrets — this file was not produced by "navapi profile export", and the secret in it should be considered compromised.`,
      );
    }
    const name = requireString(c.name, `credentials[${i}].name`);
    if (c.type === 'azureCli') return { ...c, name, type: 'azureCli' } as Credential;
    return {
      ...c,
      name,
      type: 'clientSecret',
      clientId: requireString(c.clientId, `credentials[${i}].clientId`),
    } as Credential;
  });

  const profiles: ProfileConfig[] = doc.profiles.map((entry, i) => {
    const p = asRecord(entry, `profiles[${i}]`);
    if ('clientSecret' in p || 'secret' in p || 'password' in p) {
      throw new NavApiError(
        `profiles[${i}] carries a secret. Exports never contain secrets — this file was not produced by "navapi profile export", and the secret in it should be considered compromised.`,
      );
    }
    return {
      ...p,
      name: requireString(p.name, `profiles[${i}].name`),
      // A file written before credentials existed names its client ID inline;
      // treat it the way the store treats such a profile — one credential per
      // profile, named after it.
      credential: typeof p.credential === 'string' && p.credential ? p.credential : p.name,
      tenantId: requireString(p.tenantId, `profiles[${i}].tenantId`),
      environment: requireString(p.environment, `profiles[${i}].environment`),
    } as ProfileConfig;
  });

  // Pre-credential exports carry the client ID on the profile.
  for (const [i, entry] of doc.profiles.entries()) {
    const p = asRecord(entry, `profiles[${i}]`);
    const profile = profiles[i];
    if (!profile) continue;
    if (typeof p.clientId === 'string' && !credentials.some((c) => c.name === profile.credential)) {
      credentials.push({ name: profile.credential, type: 'clientSecret', clientId: p.clientId });
    }
  }

  return { version, credentials, profiles };
}

export interface ImportPlanOptions {
  /** `oldName=newName` pairs applied to profiles before collision checks. */
  rename?: Record<string, string>;
  overwrite?: boolean;
}

export interface ImportPlan {
  credentials: Credential[];
  profiles: ProfileConfig[];
  /** Names already present locally that this import replaces. */
  replacing: { profiles: string[]; credentials: string[] };
  /** Imported credentials with no secret stored locally yet. */
  needSecret: string[];
}

/**
 * Works out what an import would do, without doing it. Collisions are refused
 * by default and listed together, so a run either applies cleanly or explains
 * everything wrong with it in one go rather than one name at a time.
 */
export function planImport(
  incoming: PortableConfig,
  existing: { profiles: ProfileConfig[]; credentials: Credential[] },
  hasSecret: (credentialName: string) => boolean,
  opts: ImportPlanOptions = {},
): ImportPlan {
  const rename = opts.rename ?? {};
  const unknownRename = Object.keys(rename).filter(
    (from) => !incoming.profiles.some((p) => p.name === from),
  );
  if (unknownRename.length) {
    throw new NavApiError(
      `--rename names ${unknownRename.map((n) => `"${n}"`).join(', ')}, which ${
        unknownRename.length > 1 ? 'are' : 'is'
      } not in this file. It holds: ${incoming.profiles.map((p) => p.name).join(', ')}`,
    );
  }

  const profiles = incoming.profiles.map((p) => ({ ...p, name: rename[p.name] ?? p.name }));
  const credentials = incoming.credentials;

  const existingProfiles = new Set(existing.profiles.map((p) => p.name));
  const existingCredentials = new Set(existing.credentials.map((c) => c.name));
  const clashingProfiles = profiles.filter((p) => existingProfiles.has(p.name)).map((p) => p.name);
  const clashingCredentials = credentials
    .filter((c) => existingCredentials.has(c.name))
    .map((c) => c.name);

  if (!opts.overwrite && (clashingProfiles.length || clashingCredentials.length)) {
    const parts = [
      clashingProfiles.length ? `profiles: ${clashingProfiles.join(', ')}` : undefined,
      clashingCredentials.length ? `credentials: ${clashingCredentials.join(', ')}` : undefined,
    ].filter(Boolean);
    throw new NavApiError(
      `Already here — ${parts.join('; ')}. Nothing was imported. ` +
        'Use --overwrite to replace them, or --rename old=new to keep both.',
    );
  }

  // Every profile must end up pointing at a credential that will exist.
  const available = new Set([...existingCredentials, ...credentials.map((c) => c.name)]);
  const dangling = profiles.filter((p) => !available.has(p.credential));
  if (dangling.length) {
    throw new NavApiError(
      `${dangling.map((p) => `"${p.name}"`).join(', ')} reference credentials this file does not include and you do not have: ` +
        `${[...new Set(dangling.map((p) => p.credential))].join(', ')}.`,
    );
  }

  return {
    credentials,
    profiles,
    replacing: { profiles: clashingProfiles, credentials: clashingCredentials },
    // az CLI credentials need no secret; client-secret ones do, unless one is
    // already stored locally under that name.
    needSecret: credentials
      .filter((c) => c.type === 'clientSecret' && !hasSecret(c.name))
      .map((c) => c.name),
  };
}
