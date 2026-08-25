import { describe, expect, it } from 'vitest';
import { parseSetArgs } from '../src/commands/crud.js';
import { parseAuthType } from '../src/commands/profile.js';

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

  it('accepts client-credentials spellings', () => {
    expect(parseAuthType('clientCredentials')).toBe('clientCredentials');
    expect(parseAuthType('client-credentials')).toBe('clientCredentials');
  });

  it('rejects anything else', () => {
    expect(() => parseAuthType('managedIdentity')).toThrow(/Unknown --auth value/);
  });
});
