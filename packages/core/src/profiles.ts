import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultConfigDir } from './cache.js';
import { NavApiError } from './errors.js';
import type { ProfileConfig } from './types.js';

interface ProfilesFile {
  profiles: Record<string, ProfileConfig>;
  defaultProfile?: string;
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
      const parsed = JSON.parse(raw) as ProfilesFile;
      return { profiles: parsed.profiles ?? {}, defaultProfile: parsed.defaultProfile };
    } catch {
      return { profiles: {} };
    }
  }

  private async save(data: ProfilesFile): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file, JSON.stringify(data, null, 2), 'utf8');
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
      // keyring throws on missing entries on some platforms
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
  const factory =
    opts.keyringFactory !== undefined ? opts.keyringFactory : await loadKeyringFactory();
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
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file, JSON.stringify(data, null, 2), 'utf8');
    try {
      await chmod(this.file, 0o600);
    } catch {
      // best effort; not meaningful on Windows ACLs
    }
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
