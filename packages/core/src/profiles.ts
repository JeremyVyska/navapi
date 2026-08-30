import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultConfigDir } from './cache.js';
import { NavApiError } from './errors.js';
import type { Credential, ProfileConfig, ResolvedProfile, StoredProfile } from './types.js';

interface ConfigFile {
  credentials: Record<string, Credential>;
  profiles: Record<string, ProfileConfig>;
  defaultProfile?: string;
}

/**
 * Write through a temp file and rename, so an interrupted write can't leave a
 * truncated config behind — `load()` treats unparsable JSON as "nothing
 * configured", which the next write would then make permanent.
 *
 * The mode lands on the temp file at creation, so a secrets file is never
 * briefly readable by others the way a write-then-chmod would leave it.
 */
async function writeFileAtomic(file: string, data: string, mode?: number): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, data, mode === undefined ? 'utf8' : { encoding: 'utf8', mode });
  await rename(tmp, file);
}

/** The file as it may actually be on disk — see {@link StoredProfile}. */
interface StoredConfigFile {
  version?: number;
  credentials?: Record<string, Credential>;
  profiles: Record<string, StoredProfile>;
  defaultProfile?: string;
}

export const CONFIG_VERSION = 2;

/**
 * Rebuilds credentials and profiles from any shape navapi has written.
 *
 * Older files embed the credential in each profile, so migration mints one
 * credential per profile, named after it. That is deliberately 1:1 rather than
 * deduplicating by client ID: two profiles sharing an app registration may
 * still have different secrets stored under their own names, and merging them
 * would silently authenticate one profile with the other's secret.
 * Consolidating is the user's decision, and `navapi credential` makes it
 * explicit.
 *
 * Naming each credential after its profile has a second benefit: secrets are
 * keyed by credential name from now on and were keyed by profile name before,
 * so a migrated setup needs no keychain writes at all.
 */
/**
 * The credential embedded in a pre-v2 profile, named after that profile.
 * Shared by file migration and {@link ProfileStore.upsert}, so a legacy shape
 * means the same thing however it arrives.
 */
function credentialFromLegacy(name: string, stored: StoredProfile): Credential {
  if (stored.auth?.type === 'azureCli') {
    return { name, type: 'azureCli', account: stored.auth.account };
  }
  // No client ID anywhere is a profile we cannot authenticate. Rather than
  // guess, record an empty one so the factory can raise the error that names
  // the profile and the fix.
  return {
    name,
    type: 'clientSecret',
    clientId: stored.auth?.clientId ?? stored.clientId ?? '',
  };
}

function migrate(parsed: StoredConfigFile): ConfigFile {
  const credentials: Record<string, Credential> = { ...(parsed.credentials ?? {}) };
  const profiles: Record<string, ProfileConfig> = {};

  for (const [name, stored] of Object.entries(parsed.profiles ?? {})) {
    const { auth, clientId, credential, ...rest } = stored;
    if (credential) {
      profiles[name] = { ...rest, name, credential };
      continue;
    }
    // v1 (`auth`) or v0 (top-level `clientId`); v0 always meant client-credentials.
    credentials[name] ??= credentialFromLegacy(name, { auth, clientId, ...rest, name });
    profiles[name] = { ...rest, name, credential: name };
  }

  return { credentials, profiles, defaultProfile: parsed.defaultProfile };
}

/**
 * Writes v2, and for client-secret profiles the pre-`auth` top-level
 * `clientId` as well. Saving anything rewrites the whole file, so without the
 * legacy field a single `profile add` would move untouched profiles to a shape
 * the published 0.2.0 reads as `clientId: undefined` — which fails against
 * Entra with an opaque `invalid_client`. A migrated credential shares its
 * profile's name, so 0.2.0 still finds the secret too.
 */
function serializeProfile(profile: ProfileConfig, credential?: Credential): StoredProfile {
  if (credential?.type !== 'clientSecret') return profile;
  return { ...profile, clientId: credential.clientId };
}

/**
 * Named credentials and profiles in `<configDir>/profiles.json` (no secrets in
 * here). Both live in one file so a single atomic write keeps a profile and the
 * credential it references consistent.
 */
export class ProfileStore {
  private readonly file: string;
  private readonly dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? defaultConfigDir();
    this.file = path.join(this.dir, 'profiles.json');
  }

  async load(): Promise<ConfigFile> {
    try {
      const raw = await readFile(this.file, 'utf8');
      return migrate(JSON.parse(raw) as StoredConfigFile);
    } catch {
      return { credentials: {}, profiles: {} };
    }
  }

  private async save(data: ConfigFile): Promise<void> {
    const stored: StoredConfigFile = {
      version: CONFIG_VERSION,
      credentials: data.credentials,
      profiles: Object.fromEntries(
        Object.entries(data.profiles).map(([name, p]) => [
          name,
          serializeProfile(p, data.credentials[p.credential]),
        ]),
      ),
      defaultProfile: data.defaultProfile,
    };
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeFileAtomic(this.file, JSON.stringify(stored, null, 2));
  }

  // ------------------------------------------------------------ credentials

  async listCredentials(): Promise<Credential[]> {
    const { credentials } = await this.load();
    return Object.values(credentials).sort((a, b) => a.name.localeCompare(b.name));
  }

  async getCredential(name: string): Promise<Credential> {
    const { credentials } = await this.load();
    const credential = credentials[name];
    if (!credential) {
      const known = Object.keys(credentials);
      throw new NavApiError(
        `Credential "${name}" not found.${known.length ? ` Known credentials: ${known.join(', ')}` : ''}`,
      );
    }
    return credential;
  }

  async upsertCredential(credential: Credential): Promise<void> {
    const data = await this.load();
    data.credentials[credential.name] = credential;
    await this.save(data);
  }

  /** Refuses while a profile still points at it, naming the profiles. */
  async removeCredential(name: string): Promise<void> {
    const data = await this.load();
    if (!data.credentials[name]) throw new NavApiError(`Credential "${name}" does not exist`);
    const used = Object.values(data.profiles).filter((p) => p.credential === name);
    if (used.length) {
      throw new NavApiError(
        `Credential "${name}" is still used by ${used.map((p) => `"${p.name}"`).join(', ')}. ` +
          'Repoint or remove those profiles first.',
      );
    }
    delete data.credentials[name];
    await this.save(data);
  }

  // --------------------------------------------------------------- profiles

  /**
   * `upsert` is public, and callers outside this package still build the
   * pre-credential literal with an embedded `clientId` or `auth` (the MCP
   * server's own tests do). Such a profile mints a credential named after
   * itself, exactly as reading an older file does — one meaning for the legacy
   * shape however it arrives.
   */
  async upsert(profile: ProfileConfig, opts: { makeDefault?: boolean } = {}): Promise<void> {
    const legacy = profile as ProfileConfig & StoredProfile;
    if (!profile.credential && (legacy.clientId || legacy.auth)) {
      const { clientId, auth, ...rest } = legacy;
      return this.upsertWithCredential(rest, credentialFromLegacy(profile.name, legacy), opts);
    }
    const data = await this.load();
    if (!data.credentials[profile.credential]) {
      throw new NavApiError(
        `Profile "${profile.name}" references credential "${profile.credential}", which does not exist.`,
      );
    }
    data.profiles[profile.name] = profile;
    if (opts.makeDefault || !data.defaultProfile) data.defaultProfile = profile.name;
    await this.save(data);
  }

  /** Saves a credential and a profile that uses it in one atomic write. */
  async upsertWithCredential(
    profile: Omit<ProfileConfig, 'credential'>,
    credential: Credential,
    opts: { makeDefault?: boolean } = {},
  ): Promise<void> {
    const data = await this.load();
    data.credentials[credential.name] = credential;
    data.profiles[profile.name] = { ...profile, credential: credential.name };
    if (opts.makeDefault || !data.defaultProfile) data.defaultProfile = profile.name;
    await this.save(data);
  }

  async remove(name: string): Promise<void> {
    const data = await this.load();
    if (!data.profiles[name]) throw new NavApiError(`Profile "${name}" does not exist`);
    delete data.profiles[name];
    if (data.defaultProfile === name) data.defaultProfile = Object.keys(data.profiles)[0];
    await this.save(data);
  }

  async setDefault(name: string): Promise<void> {
    const data = await this.load();
    if (!data.profiles[name]) throw new NavApiError(`Profile "${name}" does not exist`);
    data.defaultProfile = name;
    await this.save(data);
  }

  /** Resolves a profile by name, or the default profile when name is omitted. */
  async get(name?: string): Promise<ProfileConfig> {
    const data = await this.load();
    const resolved = name ?? data.defaultProfile;
    if (!resolved) {
      throw new NavApiError(
        'No profile configured. Create one with: navapi profile add <name> ...',
      );
    }
    const profile = data.profiles[resolved];
    if (!profile) {
      const known = Object.keys(data.profiles);
      throw new NavApiError(
        `Profile "${resolved}" not found.${known.length ? ` Known profiles: ${known.join(', ')}` : ''}`,
      );
    }
    return profile;
  }

  /** A profile with its credential attached, which is what building a client needs. */
  async resolve(name?: string): Promise<ResolvedProfile> {
    const data = await this.load();
    const profile = await this.get(name);
    const resolvedCredential = data.credentials[profile.credential];
    if (!resolvedCredential) {
      throw new NavApiError(
        `Profile "${profile.name}" references credential "${profile.credential}", which does not exist. ` +
          `Create it with: navapi credential add ${profile.credential} ...`,
      );
    }
    return { ...profile, resolvedCredential };
  }

  async listAll(): Promise<{
    profiles: ProfileConfig[];
    credentials: Credential[];
    defaultProfile?: string;
  }> {
    const data = await this.load();
    return {
      profiles: Object.values(data.profiles).sort((a, b) => a.name.localeCompare(b.name)),
      credentials: Object.values(data.credentials).sort((a, b) => a.name.localeCompare(b.name)),
      defaultProfile: data.defaultProfile,
    };
  }
}

/**
 * Pluggable secret storage. {@link resolveSecretStore} picks the best
 * available backend: OS keychain (via @napi-rs/keyring) layered over the
 * file store, or the file store alone when no keychain is available.
 */
export interface SecretStore {
  get(profileName: string): Promise<string | undefined>;
  set(profileName: string, secret: string): Promise<void>;
  delete(profileName: string): Promise<void>;
}

/** Minimal surface of @napi-rs/keyring's Entry, injectable for tests. */
export interface KeyringEntry {
  getPassword(): string | null;
  setPassword(secret: string): void;
  deletePassword(): boolean;
}

export type KeyringFactory = (service: string, account: string) => KeyringEntry;

const KEYRING_SERVICE = 'navapi';

let probedKeyring: KeyringFactory | null | undefined;

/**
 * Loads @napi-rs/keyring if it is installed and its native binding works on
 * this platform; returns null otherwise (callers fall back to the file
 * store). Probed once per process.
 */
export async function loadKeyringFactory(): Promise<KeyringFactory | null> {
  if (probedKeyring !== undefined) return probedKeyring;
  try {
    const mod = (await import('@napi-rs/keyring')) as {
      Entry?: new (service: string, account: string) => KeyringEntry;
    };
    const Entry = mod.Entry;
    probedKeyring = Entry ? (service, account) => new Entry(service, account) : null;
  } catch {
    probedKeyring = null;
  }
  return probedKeyring;
}

/** Secrets in the OS keychain (Credential Manager / Keychain / libsecret). */
export class KeychainSecretStore implements SecretStore {
  constructor(
    private readonly factory: KeyringFactory,
    private readonly service: string = KEYRING_SERVICE,
  ) {}

  async get(profileName: string): Promise<string | undefined> {
    try {
      return this.factory(this.service, profileName).getPassword() ?? undefined;
    } catch {
      // Some platforms throw for a missing entry; Linux returns null instead,
      // which is why a missing secret and an unreachable keyring look alike.
      return undefined;
    }
  }

  async set(profileName: string, secret: string): Promise<void> {
    this.factory(this.service, profileName).setPassword(secret);
  }

  async delete(profileName: string): Promise<void> {
    try {
      this.factory(this.service, profileName).deletePassword();
    } catch {
      // nothing to delete
    }
  }
}

/**
 * Primary store with fallback reads: secrets found only in the fallback are
 * migrated to the primary (best effort), so pre-keychain file secrets move
 * into the keychain the first time they're used. Writes prefer the primary
 * and clear any stale fallback copy.
 */
export class LayeredSecretStore implements SecretStore {
  constructor(
    private readonly primary: SecretStore,
    private readonly fallback: SecretStore,
  ) {}

  async get(profileName: string): Promise<string | undefined> {
    const fromPrimary = await this.primary.get(profileName);
    if (fromPrimary !== undefined) return fromPrimary;
    const fromFallback = await this.fallback.get(profileName);
    if (fromFallback !== undefined) {
      try {
        await this.primary.set(profileName, fromFallback);
        await this.fallback.delete(profileName);
      } catch {
        // keep the fallback copy if migration fails
      }
    }
    return fromFallback;
  }

  async set(profileName: string, secret: string): Promise<void> {
    try {
      await this.primary.set(profileName, secret);
      await this.fallback.delete(profileName);
    } catch {
      await this.fallback.set(profileName, secret);
    }
  }

  async delete(profileName: string): Promise<void> {
    await this.primary.delete(profileName);
    await this.fallback.delete(profileName);
  }
}

export interface ResolvedSecretStore {
  store: SecretStore;
  backend: 'keychain' | 'file';
}

export function isHeadlessLinux(
  platform: NodeJS.Platform = process.platform,
  sessionBus: string | null | undefined = process.env.DBUS_SESSION_BUS_ADDRESS,
): boolean {
  return platform === 'linux' && !sessionBus;
}

/**
 * Whether the OS keychain is a durable place to leave the only copy of a
 * secret.
 *
 * Everywhere except Linux, yes. On Linux `@napi-rs/keyring` silently falls
 * back from the D-Bus Secret Service to the kernel keyring when no session bus
 * is reachable — over SSH, in a container, from a systemd unit. Writes there
 * succeed, so nothing throws, but the kernel keyring is cleared at reboot and
 * expires on its own (`/proc/sys/kernel/keys/persistent_keyring_expiry`,
 * three days by default). `LayeredSecretStore` would take that success as
 * permission to delete the file copy, and the secret would be gone.
 *
 * So: no Secret Service means no keychain, and the file store stays in charge.
 */
export function secretServiceAvailable(): boolean {
  if (process.platform !== 'linux') return true;
  if (process.env.DBUS_SESSION_BUS_ADDRESS) return true;
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  return Boolean(runtimeDir) && existsSync(path.join(runtimeDir as string, 'bus'));
}

/**
 * The store every face should use. Prefers the OS keychain (layered over the
 * file store so existing secrets migrate); falls back to the plain file
 * store when no keychain is available, Linux has no desktop D-Bus session, or
 * NAVAPI_SECRET_BACKEND=file.
 */
export async function resolveSecretStore(
  dir?: string,
  opts: { keyringFactory?: KeyringFactory | null } = {},
): Promise<ResolvedSecretStore> {
  const file = new FileSecretStore(dir);
  if (
    process.env.NAVAPI_SECRET_BACKEND === 'file' ||
    (opts.keyringFactory === undefined && isHeadlessLinux())
  ) {
    return { store: file, backend: 'file' };
  }
  let factory: KeyringFactory | null;
  if (opts.keyringFactory !== undefined) {
    // An injected factory is the caller's own store, so the probe below —
    // which is about the native keyring's behaviour on Linux — doesn't apply.
    factory = opts.keyringFactory;
  } else {
    factory = await loadKeyringFactory();
    if (factory && !secretServiceAvailable()) factory = null;
  }
  if (!factory) return { store: file, backend: 'file' };
  return {
    store: new LayeredSecretStore(new KeychainSecretStore(factory), file),
    backend: 'keychain',
  };
}

export class FileSecretStore implements SecretStore {
  private readonly file: string;
  private readonly dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? defaultConfigDir();
    this.file = path.join(this.dir, 'secrets.json');
  }

  private async load(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private async save(data: Record<string, string>): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeFileAtomic(this.file, JSON.stringify(data, null, 2), 0o600);
  }

  async get(profileName: string): Promise<string | undefined> {
    return (await this.load())[profileName];
  }

  async set(profileName: string, secret: string): Promise<void> {
    const data = await this.load();
    data[profileName] = secret;
    await this.save(data);
  }

  async delete(profileName: string): Promise<void> {
    const data = await this.load();
    delete data[profileName];
    await this.save(data);
  }
}
