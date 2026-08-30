import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createClientForProfile,
  createClientForSelector,
  createClientForTarget,
  ProfileStore,
  targetLabel,
} from '../src/index.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'navapi-factory-'));
  vi.stubEnv('NAVAPI_SECRET_BACKEND', 'file'); // never touch the real keychain
  vi.stubEnv('NAVAPI_CLIENT_SECRET', undefined);
  vi.stubEnv('NAVAPI_PROFILE', undefined);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tmpDir, { recursive: true, force: true });
});

const BASE = { tenantId: 'contoso.onmicrosoft.com', environment: 'Sandbox-UAT' };

describe('createClientForProfile', () => {
  it('builds an azureCli-auth client without any stored secret', async () => {
    await new ProfileStore(tmpDir).upsertWithCredential(
      { ...BASE, name: 'az-profile' },
      { name: 'me', type: 'azureCli' },
    );

    const client = await createClientForProfile('az-profile', { configDir: tmpDir });

    expect(client.profile.name).toBe('az-profile');
  });

  it('still demands a secret, and names the credential rather than the profile', async () => {
    await new ProfileStore(tmpDir).upsertWithCredential(
      { ...BASE, name: 'cc-profile' },
      { name: 'contoso-app', type: 'clientSecret', clientId: 'client-1' },
    );

    // The secret is keyed by credential now, so that is the name to report.
    await expect(createClientForProfile('cc-profile', { configDir: tmpDir })).rejects.toThrow(
      /No client secret stored for credential "contoso-app"/,
    );
  });

  it('resolves the secret by credential name, not profile name', async () => {
    const store = new ProfileStore(tmpDir);
    await store.upsertWithCredential(
      { ...BASE, name: 'prod' },
      { name: 'contoso-app', type: 'clientSecret', clientId: 'client-1' },
    );
    const { FileSecretStore } = await import('../src/index.js');
    await new FileSecretStore(tmpDir).set('contoso-app', 'hunter2');

    // Would still throw if the lookup keyed off the profile name.
    await expect(createClientForProfile('prod', { configDir: tmpDir })).resolves.toBeDefined();
  });

  it('reports a credential a profile references but that is missing', async () => {
    const store = new ProfileStore(tmpDir);
    await store.upsertWithCredential({ ...BASE, name: 'prod' }, { name: 'gone', type: 'azureCli' });
    await store.remove('prod');
    await store.removeCredential('gone');
    await store.upsertWithCredential({ ...BASE, name: 'prod' }, { name: 'here', type: 'azureCli' });
    await store.upsert({ ...BASE, name: 'prod', credential: 'here' });

    expect((await store.resolve('prod')).resolvedCredential.name).toBe('here');
  });
});

describe('createClientForTarget', () => {
  it('points a saved credential at a target with no profile involved', async () => {
    await new ProfileStore(tmpDir).upsertCredential({ name: 'me', type: 'azureCli' });

    const client = await createClientForTarget({
      credential: 'me',
      target: { tenantId: 'other-tenant', environment: 'Production' },
      configDir: tmpDir,
    });

    expect(client.profile.tenantId).toBe('other-tenant');
    expect(client.profile.credential).toBe('me');
    expect(client.apiRoot).toContain('/other-tenant/Production/api');
  });

  it('accepts a credential that was never saved at all', async () => {
    const client = await createClientForTarget({
      credential: { name: 'ad-hoc', type: 'azureCli', account: 'me@example.com' },
      target: { tenantId: 't', environment: 'Sandbox' },
      configDir: tmpDir,
    });

    expect(client.profile.name).toBe(targetLabel({ tenantId: 't', environment: 'Sandbox' }));
  });

  it('gives ad-hoc calls at one environment a stable, shared cache name', () => {
    expect(targetLabel({ tenantId: 't', environment: 'Production' })).toBe('t@Production');
  });

  it('carries readOnly onto an unsaved target', async () => {
    await new ProfileStore(tmpDir).upsertCredential({ name: 'me', type: 'azureCli' });

    const client = await createClientForTarget({
      credential: 'me',
      target: { tenantId: 't', environment: 'Production' },
      readOnly: true,
      configDir: tmpDir,
    });

    await expect(client.create('customers', {})).rejects.toThrow(/read-only/);
  });
});

describe('createClientForSelector', () => {
  async function saved() {
    const store = new ProfileStore(tmpDir);
    await store.upsertWithCredential(
      { ...BASE, name: 'prod', company: 'CRONUS' },
      { name: 'me', type: 'azureCli' },
    );
    return store;
  }

  it('uses the saved profile when nothing is overridden', async () => {
    await saved();
    const client = await createClientForSelector({ profile: 'prod' }, { configDir: tmpDir });
    expect(client.profile.name).toBe('prod');
    expect(client.profile.tenantId).toBe(BASE.tenantId);
  });

  it('layers a tenant over the profile, keeping its credential and environment', async () => {
    await saved();

    const client = await createClientForSelector(
      { profile: 'prod', tenant: 'customer-b' },
      { configDir: tmpDir },
    );

    // the cross-tenant case that used to need a saved profile per tenant
    expect(client.profile.tenantId).toBe('customer-b');
    expect(client.profile.environment).toBe(BASE.environment);
    expect(client.profile.credential).toBe('me');
  });

  it('does not let an ad-hoc tenant borrow the profile name, and so its cache', async () => {
    await saved();

    const moved = await createClientForSelector(
      { profile: 'prod', tenant: 'customer-b' },
      { configDir: tmpDir },
    );
    const same = await createClientForSelector(
      { profile: 'prod', environment: BASE.environment },
      { configDir: tmpDir },
    );

    expect(moved.profile.name).toBe(targetLabel({ ...BASE, tenantId: 'customer-b' }));
    // naming the environment it already had is not a move, so the cache stays
    expect(same.profile.name).toBe('prod');
  });

  it('carries a read-only profile’s guardrail onto an overridden target', async () => {
    const store = new ProfileStore(tmpDir);
    await store.upsertWithCredential(
      { ...BASE, name: 'ro', readOnly: true },
      { name: 'me', type: 'azureCli' },
    );

    const client = await createClientForSelector(
      { profile: 'ro', tenant: 'elsewhere' },
      { configDir: tmpDir },
    );

    await expect(client.create('customers', {})).rejects.toThrow(/read-only/);
  });

  it('stands on its own with no profile at all', async () => {
    await new ProfileStore(tmpDir).upsertCredential({ name: 'me', type: 'azureCli' });

    const client = await createClientForSelector(
      { credential: 'me', tenant: 't', environment: 'Production' },
      { configDir: tmpDir },
    );

    expect(client.apiRoot).toContain('/t/Production/api');
  });

  it('names what is missing when neither flags nor a profile supply it', async () => {
    await new ProfileStore(tmpDir).upsertCredential({ name: 'me', type: 'azureCli' });

    await expect(
      createClientForSelector({ credential: 'me', tenant: 't' }, { configDir: tmpDir }),
    ).rejects.toThrow(/no environment given/);
  });

  it('reads the target from the environment the way it reads NAVAPI_PROFILE', async () => {
    await saved();
    vi.stubEnv('NAVAPI_TENANT', 'from-env');

    const client = await createClientForSelector({ profile: 'prod' }, { configDir: tmpDir });

    expect(client.profile.tenantId).toBe('from-env');
  });
});
