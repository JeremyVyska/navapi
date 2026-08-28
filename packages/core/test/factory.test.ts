import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClientForProfile, ProfileStore } from '../src/index.js';

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
    await new ProfileStore(tmpDir).upsert({
      ...BASE,
      name: 'az-profile',
      auth: { type: 'azureCli' },
    });

    const client = await createClientForProfile('az-profile', { configDir: tmpDir });

    expect(client.profile.name).toBe('az-profile');
  });

  it('still demands a secret for client-credentials profiles', async () => {
    await new ProfileStore(tmpDir).upsert({
      ...BASE,
      name: 'cc-profile',
      auth: { type: 'clientSecret', clientId: 'client-1' },
    });

    await expect(createClientForProfile('cc-profile', { configDir: tmpDir })).rejects.toThrow(
      /No client secret stored/,
    );
  });
});
