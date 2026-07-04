import { describe, expect, it } from 'vitest';
import { parseSetArgs } from '../src/commands/crud.js';

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
