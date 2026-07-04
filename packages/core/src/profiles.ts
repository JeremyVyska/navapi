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
 * Pluggable secret storage. The default implementation is a file with
 * owner-only permissions; an OS-keychain backend can implement this same
 * interface later without touching callers.
 */
export interface SecretStore {
  get(profileName: string): Promise<string | undefined>;
  set(profileName: string, secret: string): Promise<void>;
  delete(profileName: string): Promise<void>;
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
