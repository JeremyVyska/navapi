import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultConfigDir } from './cache.js';
import { NavApiError } from './errors.js';
import type { ProfileAuth, ProfileConfig, StoredProfile } from './types.js';

interface ProfilesFile {
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

/** The file as it may actually be on disk, including pre-`auth` profiles. */
interface StoredProfilesFile {
  profiles: Record<string, StoredProfile>;
  defaultProfile?: string;
}

/**
 * Reads a profile written by any version. Before `auth` existed a profile
 * carried `clientId` at the top level and meant client-credentials; that is
 * the only other shape ever released, so it is the only one migrated.
 *
 * Migration happens in memory on read, and `serializeProfile` writes the
 * legacy field back out alongside the new one — so no navapi version is ever
 * left with a profile it can't read. That matters because any write rewrites
 * the whole file, not just the profile being changed.
 */
function normalizeProfile(stored: StoredProfile): ProfileConfig {
  const { clientId, auth, ...rest } = stored;
  return { ...rest, auth: auth ?? inferAuth(clientId) };
}

function inferAuth(clientId?: string): ProfileAuth {
  // No clientId and no auth is a profile we can't authenticate. Rather than
  // guess, record it as client-credentials with an empty client ID so the
  // factory can raise the error that names the profile and the fix.
  return { type: 'clientSecret', clientId: clientId ?? '' };
}

/**
 * Writes the `auth` union and, for client-secret profiles, the pre-`auth`
 * top-level `clientId` as well. Saving any profile rewrites every profile in
 * the file, so without the legacy field a single `profile add` would move
 * untouched profiles to a shape an older navapi reads as `clientId:
 * undefined` — which fails against Entra with an opaque `invalid_client`.
 */
function serializeProfile(profile: ProfileConfig): StoredProfile {
  // Normalize on the way in as well: `upsert` is public and callers outside
  // this package still build the pre-`auth` literal with a top-level clientId
  // (the MCP server's own tests do). Reading `profile.auth.type` directly
  // threw on those, so one write path now handles both shapes, the same way
  // `load()` handles both on read.
  const normalized = normalizeProfile(profile as StoredProfile);
  if (normalized.auth.type !== 'clientSecret') return normalized;
  return { ...normalized, clientId: normalized.auth.clientId };
}

/** Named profiles stored in `<configDir>/profiles.json` (no secrets in here). */
export class ProfileStore {
  private readonly file: string;
  private readonly dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? defaultConfigDir();
    this.file = path.join(this.dir, 'profiles.json');
  }

  async load(): Promise<ProfilesFile> {
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as StoredProfilesFile;
      const profiles: Record<string, ProfileConfig> = {};
      for (const [name, stored] of Object.entries(parsed.profiles ?? {})) {
        profiles[name] = normalizeProfile(stored);
      }
      return { profiles, defaultProfile: parsed.defaultProfile };
    } catch {
      return { profiles: {} };
    }
  }

  private async save(data: ProfilesFile): Promise<void> {
    const stored: StoredProfilesFile = {
      profiles: Object.fromEntries(
        Object.entries(data.profiles).map(([name, p]) => [name, serializeProfile(p)]),
      ),
      defaultProfile: data.defaultProfile,
    };
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeFileAtomic(this.file, JSON.stringify(stored, null, 2));
  }

  async upsert(profile: ProfileConfig, opts: { makeDefault?: boolean } = {}): Promise<void> {
    const data = await this.load();
    data.profiles[profile.name] = profile;
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

  async listAll(): Promise<{ profiles: ProfileConfig[]; defaultProfile?: string }> {
    const data = await this.load();
    return {
      profiles: Object.values(data.profiles).sort((a, b) => a.name.localeCompare(b.name)),
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
 * store when no keychain is available or NAVAPI_SECRET_BACKEND=file.
 */
export async function resolveSecretStore(
  dir?: string,
  opts: { keyringFactory?: KeyringFactory | null } = {},
): Promise<ResolvedSecretStore> {
  const file = new FileSecretStore(dir);
  if (process.env.NAVAPI_SECRET_BACKEND === 'file') {
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
