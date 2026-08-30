import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FileSecretStore,
  KeychainSecretStore,
  type KeyringFactory,
  LayeredSecretStore,
  MetadataCache,
  type ProfileConfig,
  ProfileStore,
  resolveSecretStore,
  secretServiceAvailable,
} from '../src/index.js';
import { isHeadlessLinux } from '../src/profiles.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'navapi-prof-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const PROFILE: ProfileConfig = {
  name: 'contoso-prod',
  tenantId: 't',
  auth: { type: 'clientSecret', clientId: 'c' },
  environment: 'Production',
  company: 'CRONUS',
};

describe('ProfileStore', () => {
  it('round-trips profiles and makes the first one default', async () => {
    const store = new ProfileStore(tmpDir);
    await store.upsert(PROFILE);
    await store.upsert({ ...PROFILE, name: 'contoso-uat', environment: 'UAT' });

    expect((await store.get()).name).toBe('contoso-prod');
    expect((await store.get('contoso-uat')).environment).toBe('UAT');

    await store.setDefault('contoso-uat');
    expect((await store.get()).name).toBe('contoso-uat');
  });

  it('removes profiles and reassigns the default', async () => {
    const store = new ProfileStore(tmpDir);
    await store.upsert(PROFILE);
    await store.upsert({ ...PROFILE, name: 'other' });
    await store.remove('contoso-prod');
    expect((await store.get()).name).toBe('other');
    await expect(store.get('contoso-prod')).rejects.toThrow(/not found/);
  });

  it('round-trips an azureCli profile, which has no client ID', async () => {
    const store = new ProfileStore(tmpDir);
    await store.upsert({
      name: 'az-profile',
      tenantId: 't',
      auth: { type: 'azureCli', account: 'me@example.com' },
      environment: 'Sandbox-UAT',
    });

    const saved = await store.get('az-profile');
    expect(saved.auth).toEqual({ type: 'azureCli', account: 'me@example.com' });
  });

  it('reads a profile written before `auth` existed as client-credentials', async () => {
    // The only other shape ever released: clientId at the top level.
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      path.join(tmpDir, 'profiles.json'),
      JSON.stringify({
        profiles: {
          legacy: {
            name: 'legacy',
            tenantId: 't',
            clientId: 'old-client',
            environment: 'Production',
          },
        },
        defaultProfile: 'legacy',
      }),
      'utf8',
    );

    const saved = await new ProfileStore(tmpDir).get('legacy');
    expect(saved.auth).toEqual({ type: 'clientSecret', clientId: 'old-client' });
  });

  it('leaves a legacy file on disk until something actually changes it', async () => {
    await mkdir(tmpDir, { recursive: true });
    const file = path.join(tmpDir, 'profiles.json');
    const original = JSON.stringify({
      profiles: { legacy: { name: 'legacy', tenantId: 't', clientId: 'c', environment: 'P' } },
    });
    await writeFile(file, original, 'utf8');

    await new ProfileStore(tmpDir).listAll(); // a plain read must not rewrite

    expect(await readFile(file, 'utf8')).toBe(original);
  });

  it('keeps an untouched profile readable by a navapi that predates `auth`', async () => {
    // Any write rewrites the whole file, so adding one profile must not strand
    // the others in a shape an older navapi reads as clientId: undefined.
    await mkdir(tmpDir, { recursive: true });
    const file = path.join(tmpDir, 'profiles.json');
    await writeFile(
      file,
      JSON.stringify({
        profiles: {
          legacy: { name: 'legacy', tenantId: 't', clientId: 'old-client', environment: 'P' },
        },
      }),
      'utf8',
    );

    const store = new ProfileStore(tmpDir);
    await store.upsert({
      name: 'other',
      tenantId: 't2',
      auth: { type: 'azureCli' },
      environment: 'Sandbox',
    });

    const written = JSON.parse(await readFile(file, 'utf8'));
    expect(written.profiles.legacy.clientId).toBe('old-client');
    expect(written.profiles.legacy.auth).toEqual({ type: 'clientSecret', clientId: 'old-client' });
    // az-cli profiles have no client ID to write back.
    expect(written.profiles.other.clientId).toBeUndefined();
  });

  it('accepts a profile handed in without `auth`, the way older embedders build one', async () => {
    // upsert is public and ProfileConfig only gained `auth` here, so callers
    // outside this package still pass the top-level clientId literal. Reading
    // profile.auth.type unguarded threw a TypeError and broke every MCP test.
    const store = new ProfileStore(tmpDir);
    await store.upsert({
      name: 'embedded',
      tenantId: 't',
      clientId: 'c',
      environment: 'Sandbox',
    } as unknown as ProfileConfig);

    const written = JSON.parse(await readFile(path.join(tmpDir, 'profiles.json'), 'utf8'));
    expect(written.profiles.embedded.auth).toEqual({ type: 'clientSecret', clientId: 'c' });
    expect(written.profiles.embedded.clientId).toBe('c');
    expect((await store.get('embedded')).auth).toEqual({ type: 'clientSecret', clientId: 'c' });
  });

  it('gives a friendly error when nothing is configured', async () => {
    const store = new ProfileStore(tmpDir);
    await expect(store.get()).rejects.toThrow(/navapi profile add/);
  });
});

describe('FileSecretStore', () => {
  it('stores and deletes secrets per profile', async () => {
    const store = new FileSecretStore(tmpDir);
    await store.set('contoso-prod', 'hunter2');
    expect(await store.get('contoso-prod')).toBe('hunter2');
    await store.delete('contoso-prod');
    expect(await store.get('contoso-prod')).toBeUndefined();
  });
});

/** In-memory keyring double matching @napi-rs/keyring's Entry surface. */
function fakeKeyring(seed: Record<string, string> = {}) {
  const vault = new Map(Object.entries(seed));
  const factory: KeyringFactory = (service, account) => ({
    getPassword: () => vault.get(`${service}/${account}`) ?? null,
    setPassword: (secret) => void vault.set(`${service}/${account}`, secret),
    deletePassword: () => vault.delete(`${service}/${account}`),
  });
  return { factory, vault };
}

describe('KeychainSecretStore', () => {
  it('round-trips secrets under the navapi service', async () => {
    const { factory, vault } = fakeKeyring();
    const store = new KeychainSecretStore(factory);
    await store.set('contoso', 'hunter2');
    expect(vault.get('navapi/contoso')).toBe('hunter2');
    expect(await store.get('contoso')).toBe('hunter2');
    await store.delete('contoso');
    expect(await store.get('contoso')).toBeUndefined();
  });
});

describe('LayeredSecretStore', () => {
  it('migrates file secrets into the keychain on first read', async () => {
    const file = new FileSecretStore(tmpDir);
    await file.set('contoso', 'from-file');
    const { factory, vault } = fakeKeyring();
    const layered = new LayeredSecretStore(new KeychainSecretStore(factory), file);

    expect(await layered.get('contoso')).toBe('from-file');
    expect(vault.get('navapi/contoso')).toBe('from-file'); // migrated in
    expect(await file.get('contoso')).toBeUndefined(); // and out of the file

    expect(await layered.get('contoso')).toBe('from-file'); // now from keychain
  });

  it('writes to the keychain and clears stale file copies', async () => {
    const file = new FileSecretStore(tmpDir);
    await file.set('contoso', 'old');
    const { factory, vault } = fakeKeyring();
    const layered = new LayeredSecretStore(new KeychainSecretStore(factory), file);

    await layered.set('contoso', 'new');
    expect(vault.get('navapi/contoso')).toBe('new');
    expect(await file.get('contoso')).toBeUndefined();
  });

  it('falls back to the file store when the keychain write fails', async () => {
    const broken: KeyringFactory = () => ({
      getPassword: () => {
        throw new Error('locked');
      },
      setPassword: () => {
        throw new Error('locked');
      },
      deletePassword: () => {
        throw new Error('locked');
      },
    });
    const file = new FileSecretStore(tmpDir);
    const layered = new LayeredSecretStore(new KeychainSecretStore(broken), file);
    await layered.set('contoso', 's3cret');
    expect(await file.get('contoso')).toBe('s3cret');
    expect(await layered.get('contoso')).toBe('s3cret');
  });
});

describe('resolveSecretStore', () => {
  // CI exports NAVAPI_SECRET_BACKEND=file as a safety net; these tests
  // control the variable themselves.
  let savedBackend: string | undefined;
  beforeEach(() => {
    savedBackend = process.env.NAVAPI_SECRET_BACKEND;
    delete process.env.NAVAPI_SECRET_BACKEND;
  });
  afterEach(() => {
    if (savedBackend === undefined) delete process.env.NAVAPI_SECRET_BACKEND;
    else process.env.NAVAPI_SECRET_BACKEND = savedBackend;
  });

  it('uses the keychain (layered) when a keyring is available', async () => {
    const { factory } = fakeKeyring();
    const resolved = await resolveSecretStore(tmpDir, { keyringFactory: factory });
    expect(resolved.backend).toBe('keychain');
    expect(resolved.store).toBeInstanceOf(LayeredSecretStore);
  });

  it('falls back to the file store when no keyring loads', async () => {
    const resolved = await resolveSecretStore(tmpDir, { keyringFactory: null });
    expect(resolved.backend).toBe('file');
    expect(resolved.store).toBeInstanceOf(FileSecretStore);
  });

  it('honors NAVAPI_SECRET_BACKEND=file even with a keyring present', async () => {
    process.env.NAVAPI_SECRET_BACKEND = 'file';
    try {
      const { factory } = fakeKeyring();
      const resolved = await resolveSecretStore(tmpDir, { keyringFactory: factory });
      expect(resolved.backend).toBe('file');
    } finally {
      delete process.env.NAVAPI_SECRET_BACKEND;
    }
  });

  it('detects Linux sessions without a desktop D-Bus', () => {
    expect(isHeadlessLinux('linux', null)).toBe(true);
    expect(isHeadlessLinux('linux', '')).toBe(true);
    expect(isHeadlessLinux('linux', 'unix:path=/run/user/1000/bus')).toBe(false);
    expect(isHeadlessLinux('win32', undefined)).toBe(false);
  });

  // Never let this opt-in smoke touch a developer or self-hosted runner's real desktop keychain.
  it.runIf(process.env.NAVAPI_HEADLESS_KEYRING_TEST === '1' && isHeadlessLinux())(
    'falls back to the file store when the real keyring has no desktop session',
    async () => {
      const resolved = await resolveSecretStore(tmpDir);
      await resolved.store.set('headless-smoke', 'headless-secret');

      expect(await resolved.store.get('headless-smoke')).toBe('headless-secret');
      expect(await new FileSecretStore(tmpDir).get('headless-smoke')).toBe('headless-secret');
    },
  );
});

const onLinux = process.platform === 'linux';
const onPosix = process.platform !== 'win32';

describe('secretServiceAvailable', () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {
      dbus: process.env.DBUS_SESSION_BUS_ADDRESS,
      runtime: process.env.XDG_RUNTIME_DIR,
    };
  });
  afterEach(() => {
    for (const [key, name] of [
      ['dbus', 'DBUS_SESSION_BUS_ADDRESS'],
      ['runtime', 'XDG_RUNTIME_DIR'],
    ] as const) {
      if (saved[key] === undefined) delete process.env[name];
      else process.env[name] = saved[key] as string;
    }
  });

  it.runIf(onLinux)('is false on Linux with no session bus to reach', () => {
    delete process.env.DBUS_SESSION_BUS_ADDRESS;
    process.env.XDG_RUNTIME_DIR = tmpDir; // exists, but has no `bus` socket
    expect(secretServiceAvailable()).toBe(false);
  });

  it.runIf(onLinux)('is true on Linux when a session bus is advertised', () => {
    process.env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/run/user/1000/bus';
    expect(secretServiceAvailable()).toBe(true);
  });

  it.runIf(!onLinux)('is true off Linux, where the keychain is always durable', () => {
    delete process.env.DBUS_SESSION_BUS_ADDRESS;
    delete process.env.XDG_RUNTIME_DIR;
    expect(secretServiceAvailable()).toBe(true);
  });
});

describe('config file writes', () => {
  it.runIf(onPosix)('creates the secrets file as 0600, never briefly wider', async () => {
    await new FileSecretStore(tmpDir).set('contoso', 'hunter2');
    const mode = (await stat(path.join(tmpDir, 'secrets.json'))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('leaves no temp files behind', async () => {
    await new ProfileStore(tmpDir).upsert(PROFILE);
    await new FileSecretStore(tmpDir).set('contoso', 'hunter2');
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(tmpDir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('MetadataCache', () => {
  it('stores per profile × route with sanitized filenames', async () => {
    const cache = new MetadataCache(tmpDir);
    await cache.set('p1', 'contoso/fieldops/v1.0', { namespace: 'X', entitySets: [] });
    await cache.set('p1', 'ODataV4', { namespace: 'Microsoft.NAV', entitySets: [] });
    await cache.set('p1', 'v2.0', { namespace: 'Microsoft.NAV', entitySets: [] });
    await cache.set('p2', 'v2.0', { namespace: 'Microsoft.NAV', entitySets: [] });

    const entry = await cache.get('p1', 'contoso/fieldops/v1.0');
    expect(entry?.metadata.namespace).toBe('X');
    expect(entry?.fetchedAt).toBeTruthy();

    const listed = await cache.list('p1');
    expect(listed.map((e) => e.routePath)).toEqual(['contoso/fieldops/v1.0', 'ODataV4', 'v2.0']);
    await cache.clear('p1');
    expect(await cache.list('p1')).toEqual([]);
    expect((await cache.list('p2')).length).toBe(1);
  });
});
