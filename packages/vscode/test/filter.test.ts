import { describe, expect, it } from 'vitest';
import { buildFilterExpression, literalFor, operatorsFor } from '../src/filter.js';

describe('operatorsFor', () => {
  it('gives string ops (contains first) for strings and unknowns', () => {
    expect(operatorsFor('Edm.String')).toEqual(['contains', 'eq', 'ne', 'startswith', 'endswith']);
    expect(operatorsFor('Something.Custom')).toContain('contains');
  });

  it('gives comparison ops for numerics and dates', () => {
    for (const t of ['Edm.Decimal', 'Edm.Int32', 'Edm.Date', 'Edm.DateTimeOffset']) {
      expect(operatorsFor(t)).toEqual(['eq', 'ne', 'gt', 'ge', 'lt', 'le']);
    }
  });

  it('limits booleans and guids to eq/ne', () => {
    expect(operatorsFor('Edm.Boolean')).toEqual(['eq', 'ne']);
    expect(operatorsFor('Edm.Guid')).toEqual(['eq', 'ne']);
  });
});

describe('literalFor', () => {
  it('quotes strings and escapes single quotes', () => {
    expect(literalFor('Edm.String', "O'Brien")).toBe("'O''Brien'");
  });

  it('leaves numerics, booleans, guids, and dates raw', () => {
    expect(literalFor('Edm.Decimal', ' 5000 ')).toBe('5000');
    expect(literalFor('Edm.Boolean', 'true')).toBe('true');
    expect(literalFor('Edm.Guid', 'aaaa-bbbb')).toBe('aaaa-bbbb');
    expect(literalFor('Edm.Date', '2026-01-01')).toBe('2026-01-01');
  });
});

describe('buildFilterExpression', () => {
  it('renders function ops as function calls and others infix', () => {
    const expr = buildFilterExpression([
      { field: 'displayName', type: 'Edm.String', op: 'contains', value: 'adatum' },
      { field: 'balanceDue', type: 'Edm.Decimal', op: 'gt', value: '1000' },
    ]);
    expect(expr).toBe("contains(displayName,'adatum') and balanceDue gt 1000");
  });

  it('supports the or combinator', () => {
    const expr = buildFilterExpression(
      [
        { field: 'blocked', type: 'Edm.String', op: 'eq', value: 'All' },
        { field: 'blocked', type: 'Edm.String', op: 'eq', value: 'Ship' },
      ],
      'or',
    );
    expect(expr).toBe("blocked eq 'All' or blocked eq 'Ship'");
  });

  it('skips incomplete rows and returns empty for none', () => {
    expect(
      buildFilterExpression([
        { field: 'number', type: 'Edm.String', op: 'eq', value: '  ' },
        { field: '', type: 'Edm.String', op: 'eq', value: 'x' },
      ]),
    ).toBe('');
    expect(buildFilterExpression([])).toBe('');
  });
});
