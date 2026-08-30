import { describe, expect, it } from 'vitest';
import {
  buildPortableConfig,
  type Credential,
  PORTABLE_VERSION,
  type ProfileConfig,
  parsePortableConfig,
  planImport,
} from '../src/index.js';

const CREDENTIALS: Credential[] = [
  { name: 'contoso-app', type: 'clientSecret', clientId: 'client-1' },
  { name: 'me', type: 'azureCli', account: 'me@example.com' },
  { name: 'unused', type: 'clientSecret', clientId: 'client-9' },
];

const PROFILES: ProfileConfig[] = [
  {
    name: 'contoso-prod',
    credential: 'contoso-app',
    tenantId: 't1',
    environment: 'Production',
    company: 'CRONUS',
    readOnly: true,
  },
  { name: 'contoso-dev', credential: 'me', tenantId: 't1', environment: 'Sandbox' },
];

const noSecrets = () => false;

describe('buildPortableConfig', () => {
  it('exports profiles with the credentials they actually use', () => {
    const config = buildPortableConfig(PROFILES, CREDENTIALS);
    expect(config.version).toBe(PORTABLE_VERSION);
    expect(config.profiles.map((p) => p.name)).toEqual(['contoso-prod', 'contoso-dev']);
    // "unused" backs nothing here, so it stays home
    expect(config.credentials.map((c) => c.name)).toEqual(['contoso-app', 'me']);
  });

  it('exporting one profile does not disclose the rest of the estate', () => {
    const config = buildPortableConfig(PROFILES, CREDENTIALS, { names: ['contoso-prod'] });
    expect(config.profiles).toHaveLength(1);
    expect(config.credentials.map((c) => c.name)).toEqual(['contoso-app']);
  });

  it('drops the pinned az identity, which is wrong on anyone else’s machine', () => {
    const config = buildPortableConfig(PROFILES, CREDENTIALS);
    const az = config.credentials.find((c) => c.name === 'me');
    expect(az).toEqual({ name: 'me', type: 'azureCli' });
    expect(az).not.toHaveProperty('account');
  });

  it('carries no secret-shaped field anywhere in the document', () => {
    // Checked structurally, not by substring: "clientSecret" is also the
    // credential *type* discriminator, so a text search reports a false hit.
    const forbidden = new Set(['clientSecret', 'secret', 'password', 'clientsecret']);
    const walk = (value: unknown, path: string): void => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        expect(forbidden.has(key), `${path}.${key} looks like a secret`).toBe(false);
        walk(child, `${path}.${key}`);
      }
    };
    walk(buildPortableConfig(PROFILES, CREDENTIALS), 'export');
  });

  it('names a profile that does not exist rather than exporting silence', () => {
    expect(() => buildPortableConfig(PROFILES, CREDENTIALS, { names: ['nope'] })).toThrow(
      /No such profile: nope/,
    );
  });

  it('keeps readOnly, company, and baseUrl on the way out', () => {
    const config = buildPortableConfig(PROFILES, CREDENTIALS, { names: ['contoso-prod'] });
    expect(config.profiles[0]).toMatchObject({ company: 'CRONUS', readOnly: true });
  });
});

describe('parsePortableConfig', () => {
  const roundTrip = () => JSON.parse(JSON.stringify(buildPortableConfig(PROFILES, CREDENTIALS)));

  it('round-trips an export', () => {
    const parsed = parsePortableConfig(roundTrip());
    expect(parsed.profiles.map((p) => p.name)).toEqual(['contoso-prod', 'contoso-dev']);
    expect(parsed.credentials.map((c) => c.name)).toEqual(['contoso-app', 'me']);
  });

  it('refuses a file carrying a secret instead of quietly dropping it', () => {
    const doc = roundTrip();
    doc.credentials[0].clientSecret = 'hunter2';
    expect(() => parsePortableConfig(doc)).toThrow(/carries a secret/);
    expect(() => parsePortableConfig(doc)).toThrow(/should be considered compromised/);
  });

  it('refuses a secret hidden on a profile too', () => {
    const doc = roundTrip();
    doc.profiles[0].password = 'hunter2';
    expect(() => parsePortableConfig(doc)).toThrow(/carries a secret/);
  });

  it('reads a pre-credential export, minting a credential per profile', () => {
    const parsed = parsePortableConfig({
      version: 1,
      profiles: [{ name: 'legacy', tenantId: 't', clientId: 'old-client', environment: 'P' }],
    });
    expect(parsed.profiles[0]?.credential).toBe('legacy');
    expect(parsed.credentials).toEqual([
      { name: 'legacy', type: 'clientSecret', clientId: 'old-client' },
    ]);
  });

  it('says to upgrade rather than guessing at a newer format', () => {
    expect(() => parsePortableConfig({ version: 99, profiles: [] })).toThrow(/Upgrade navapi/);
  });

  it('rejects documents missing the parts it needs', () => {
    expect(() => parsePortableConfig({ profiles: [] })).toThrow(/"version"/);
    expect(() => parsePortableConfig({ version: 1 })).toThrow(/"profiles"/);
    expect(() => parsePortableConfig({ version: 1, profiles: [{ name: 'x' }] })).toThrow(
      /tenantId is required/,
    );
  });
});

describe('planImport', () => {
  const incoming = buildPortableConfig(PROFILES, CREDENTIALS);
  const empty = { profiles: [], credentials: [] };

  it('imports into an empty store and reports what still needs a secret', () => {
    const plan = planImport(incoming, empty, noSecrets);
    expect(plan.profiles).toHaveLength(2);
    // az CLI needs none; the app registration does
    expect(plan.needSecret).toEqual(['contoso-app']);
  });

  it('does not ask for a secret that is already stored locally', () => {
    const plan = planImport(incoming, empty, (name) => name === 'contoso-app');
    expect(plan.needSecret).toEqual([]);
  });

  it('refuses collisions and lists all of them at once', () => {
    const existing = {
      profiles: [PROFILES[0] as ProfileConfig],
      credentials: [CREDENTIALS[0] as Credential],
    };
    expect(() => planImport(incoming, existing, noSecrets)).toThrow(/profiles: contoso-prod/);
    expect(() => planImport(incoming, existing, noSecrets)).toThrow(/credentials: contoso-app/);
    expect(() => planImport(incoming, existing, noSecrets)).toThrow(/Nothing was imported/);
  });

  it('--overwrite replaces, and says what it replaced', () => {
    const existing = { profiles: [PROFILES[0] as ProfileConfig], credentials: [] };
    const plan = planImport(incoming, existing, noSecrets, { overwrite: true });
    expect(plan.replacing.profiles).toEqual(['contoso-prod']);
  });

  it('--rename sidesteps a collision', () => {
    const existing = { profiles: [PROFILES[0] as ProfileConfig], credentials: [] };
    const plan = planImport(incoming, existing, noSecrets, {
      rename: { 'contoso-prod': 'acme-prod' },
    });
    expect(plan.profiles.map((p) => p.name)).toEqual(['acme-prod', 'contoso-dev']);
    // renaming the profile must not repoint it at a different identity
    expect(plan.profiles[0]?.credential).toBe('contoso-app');
  });

  it('catches a --rename that names a profile the file does not hold', () => {
    expect(() => planImport(incoming, empty, noSecrets, { rename: { ghost: 'x' } })).toThrow(
      /not in this file/,
    );
  });

  it('refuses a profile whose credential is neither in the file nor already here', () => {
    const orphaned = {
      version: 1,
      credentials: [],
      profiles: [
        { name: 'p', credential: 'missing', tenantId: 't', environment: 'E' } as ProfileConfig,
      ],
    };
    expect(() => planImport(orphaned, empty, noSecrets)).toThrow(/reference credentials/);
  });

  it('accepts a profile whose credential is already on this machine', () => {
    const bare = {
      version: 1,
      credentials: [],
      profiles: [
        { name: 'p', credential: 'contoso-app', tenantId: 't', environment: 'E' } as ProfileConfig,
      ],
    };
    const plan = planImport(
      bare,
      { profiles: [], credentials: [CREDENTIALS[0] as Credential] },
      noSecrets,
    );
    expect(plan.profiles).toHaveLength(1);
  });
});
