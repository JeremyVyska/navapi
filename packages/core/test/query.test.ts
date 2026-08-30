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

  it('formats named single and composite keys with typed values', () => {
    expect(formatKey({ No: '10000' })).toBe("No='10000'");
    expect(formatKey({ Document_Type: 'Order', Document_No: "O'Brien", Line_No: 10 })).toBe(
      "Document_Type='Order',Document_No='O''Brien',Line_No=10",
    );
    expect(formatKey({ Enabled: true })).toBe('Enabled=true');
  });

  it('percent-encodes reserved characters that would restructure the URL', () => {
    // `#` truncated the path at the fragment before this was encoded.
    expect(formatKey('A#1')).toBe("'A%231'");
    expect(formatKey('a?b')).toBe("'a%3Fb'");
    expect(formatKey('a&b')).toBe("'a%26b'");
    expect(formatKey('a+b')).toBe("'a%2Bb'");
    expect(formatKey('50%')).toBe("'50%25'");
    expect(formatKey('a/b')).toBe("'a%2Fb'");
    expect(formatKey('a b')).toBe("'a%20b'");
    // `)` would close the key predicate early; `,` would split it.
    expect(formatKey('a)b')).toBe("'a%29b'");
    expect(formatKey('a,b')).toBe("'a%2Cb'");
  });

  it('encodes composite key values without touching the predicate syntax', () => {
    expect(formatKey({ Document_Type: 'Order', No: 'A#1/B' })).toBe(
      "Document_Type='Order',No='A%231%2FB'",
    );
    // apostrophe escaping survives encoding, and stays readable
    expect(formatKey({ Name: "O'Brien & Co" })).toBe("Name='O''Brien%20%26%20Co'");
  });

  it('leaves GUIDs, numbers, and booleans unencoded', () => {
    expect(formatKey({ Id: '01121212-a0b0-e011-8fb2-78e7d1625bd8', Line_No: 10, Ok: false })).toBe(
      'Id=01121212-a0b0-e011-8fb2-78e7d1625bd8,Line_No=10,Ok=false',
    );
  });

  it('rejects empty keys, empty field names, and non-finite values', () => {
    expect(() => formatKey({})).toThrow(/cannot be empty/);
    expect(() => formatKey({ ' ': 'value' })).toThrow(/field names cannot be empty/);
    expect(() => formatKey({ Value: Number.NaN })).toThrow(/non-finite/);
  });
});
