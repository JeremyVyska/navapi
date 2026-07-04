import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileSecretStore, MetadataCache, ProfileStore } from '../src/index.js';

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
