import { describe, expect, it } from 'vitest';
import { parseSetArgs } from '../src/commands/crud.js';
import { parseAuthType, resolveIdentityChoice, strayAuthFlags } from '../src/commands/profile.js';

describe('parseSetArgs', () => {
  it('parses strings, numbers, booleans, and JSON values', () => {
    expect(parseSetArgs(['blocked=All', 'creditLimit=5000', 'taxLiable=true'])).toEqual({
      blocked: 'All',
      creditLimit: 5000,
      taxLiable: true,
    });
  });

  it('keeps values containing = intact', () => {
    expect(parseSetArgs(['note=a=b'])).toEqual({ note: 'a=b' });
  });

  it('rejects malformed pairs', () => {
    expect(() => parseSetArgs(['nonsense'])).toThrow(/key=value/);
    expect(() => parseSetArgs(['=value'])).toThrow(/key=value/);
  });
});

describe('parseAuthType', () => {
  it('accepts the spellings people type for Azure CLI auth', () => {
    for (const value of ['azureCli', 'azure-cli', 'az-cli', 'AzureCLI']) {
      expect(parseAuthType(value)).toBe('azureCli');
    }
  });

  it('accepts client-secret spellings, including the older name', () => {
    expect(parseAuthType('clientSecret')).toBe('clientSecret');
    expect(parseAuthType('client-secret')).toBe('clientSecret');
    // a certificate also uses the client-credentials grant, so the flag names
    // the credential — but the old spelling still resolves
    expect(parseAuthType('clientCredentials')).toBe('clientSecret');
  });

  it('rejects anything else', () => {
    expect(() => parseAuthType('managedIdentity')).toThrow(/Unknown --auth value/);
  });
});

describe('resolveIdentityChoice', () => {
  const id = (user: string) => ({ user, tenants: [], current: false });

  it('pins the only identity without asking', () => {
    expect(resolveIdentityChoice([id('me@example.com')], true)).toEqual({
      pin: 'me@example.com',
      prompt: false,
    });
  });

  it('still pins it when there is nobody to ask', () => {
    expect(resolveIdentityChoice([id('me@example.com')], false).pin).toBe('me@example.com');
  });

  it('asks when there is a real choice', () => {
    expect(resolveIdentityChoice([id('a@x.com'), id('b@y.com')], true)).toEqual({ prompt: true });
  });

  it('leaves the profile unpinned when it cannot ask between several', () => {
    expect(resolveIdentityChoice([id('a@x.com'), id('b@y.com')], false)).toEqual({
      prompt: false,
    });
  });

  it('does not pin when az reports nothing', () => {
    expect(resolveIdentityChoice([], true)).toEqual({ prompt: false });
  });
});

describe('strayAuthFlags', () => {
  it('flags app-registration options passed to az CLI auth', () => {
    expect(strayAuthFlags('azureCli', { clientId: 'c', secret: 's' })).toEqual([
      '--client-id',
      '--secret',
    ]);
  });

  it('flags an az identity passed to client-secret auth', () => {
    expect(strayAuthFlags('clientSecret', { azAccount: 'me@x.com' })).toEqual(['--az-account']);
  });

  it('passes the combinations that belong together', () => {
    expect(strayAuthFlags('clientSecret', { clientId: 'c', secret: 's' })).toBeUndefined();
    expect(strayAuthFlags('azureCli', { azAccount: 'me@x.com' })).toBeUndefined();
    expect(strayAuthFlags('azureCli', {})).toBeUndefined();
  });
});
