import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FileSecretStore,
  KeychainSecretStore,
  type KeyringFactory,
  LayeredSecretStore,
  MetadataCache,
  ProfileStore,
  resolveSecretStore,
} from '../src/index.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'navapi-prof-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const PROFILE = {
  name: 'contoso-prod',
  tenantId: 't',
  clientId: 'c',
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
});

describe('MetadataCache', () => {
  it('stores per profile × route with sanitized filenames', async () => {
    const cache = new MetadataCache(tmpDir);
    await cache.set('p1', 'contoso/fieldops/v1.0', { namespace: 'X', entitySets: [] });
    await cache.set('p1', 'v2.0', { namespace: 'Microsoft.NAV', entitySets: [] });
    await cache.set('p2', 'v2.0', { namespace: 'Microsoft.NAV', entitySets: [] });

    const entry = await cache.get('p1', 'contoso/fieldops/v1.0');
    expect(entry?.metadata.namespace).toBe('X');
    expect(entry?.fetchedAt).toBeTruthy();

    const listed = await cache.list('p1');
    expect(listed.map((e) => e.routePath)).toEqual(['contoso/fieldops/v1.0', 'v2.0']);

    await cache.clear('p1');
    expect(await cache.list('p1')).toEqual([]);
    expect((await cache.list('p2')).length).toBe(1);
  });
});
