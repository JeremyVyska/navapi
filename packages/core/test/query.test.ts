import { describe, expect, it } from 'vitest';
import { buildQueryString, formatKey, isGuid } from '../src/index.js';

describe('buildQueryString', () => {
  it('returns empty string for no query', () => {
    expect(buildQueryString()).toBe('');
    expect(buildQueryString({})).toBe('');
  });

  it('encodes filters with %20, not +', () => {
    const qs = buildQueryString({ filter: "status eq 'Open'" });
    expect(qs).toBe("?$filter=status%20eq%20'Open'");
  });

  it('combines options', () => {
    const qs = buildQueryString({
      filter: 'blocked ne ' + "''",
      select: ['number', 'displayName'],
      orderby: ['number desc'],
      top: 5,
      skip: 10,
      count: true,
    });
    expect(qs).toContain('$select=number%2CdisplayName');
    expect(qs).toContain('$orderby=number%20desc');
    expect(qs).toContain('$top=5');
    expect(qs).toContain('$skip=10');
    expect(qs).toContain('$count=true');
  });
});

describe('formatKey', () => {
  it('leaves GUIDs bare', () => {
    expect(isGuid('01121212-a0b0-e011-8fb2-78e7d1625bd8')).toBe(true);
    expect(formatKey('01121212-a0b0-e011-8fb2-78e7d1625bd8')).toBe(
      '01121212-a0b0-e011-8fb2-78e7d1625bd8',
    );
  });

  it('quotes and escapes string keys', () => {
    expect(formatKey('10000')).toBe("'10000'");
    expect(formatKey("O'Brien")).toBe("'O''Brien'");
  });
});
