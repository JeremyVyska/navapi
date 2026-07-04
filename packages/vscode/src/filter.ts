/**
 * Pure OData $filter building for the records panel — no vscode imports.
 * The webview only collects rows; expressions are built (and quoted) here,
 * so literal rules live in one tested place.
 */

export interface FilterField {
  name: string;
  type: string;
  /** Operators valid for this field's EDM type, first one is the default. */
  ops: string[];
}

export interface FilterRow {
  field: string;
  type: string;
  op: string;
  value: string;
}

const NUMERIC_TYPES = new Set([
  'Edm.Decimal',
  'Edm.Double',
  'Edm.Single',
  'Edm.Int16',
  'Edm.Int32',
  'Edm.Int64',
  'Edm.Byte',
  'Edm.SByte',
]);

/** Types whose literals go into the expression unquoted. */
const RAW_TYPES = new Set([
  ...NUMERIC_TYPES,
  'Edm.Boolean',
  'Edm.Guid',
  'Edm.Date',
  'Edm.DateTimeOffset',
  'Edm.TimeOfDay',
]);

const STRING_OPS = ['contains', 'eq', 'ne', 'startswith', 'endswith'];
const COMPARE_OPS = ['eq', 'ne', 'gt', 'ge', 'lt', 'le'];
const FUNCTION_OPS = new Set(['contains', 'startswith', 'endswith']);

export function operatorsFor(type: string): string[] {
  if (type === 'Edm.Boolean' || type === 'Edm.Guid') return ['eq', 'ne'];
  if (NUMERIC_TYPES.has(type) || type.startsWith('Edm.Date') || type === 'Edm.TimeOfDay') {
    return COMPARE_OPS;
  }
  return STRING_OPS;
}

export function literalFor(type: string, value: string): string {
  const trimmed = value.trim();
  return RAW_TYPES.has(type) ? trimmed : `'${trimmed.replace(/'/g, "''")}'`;
}

/** Rows with a field, an operator, and a non-empty value become conditions. */
export function buildFilterExpression(rows: FilterRow[], combinator: 'and' | 'or' = 'and'): string {
  const parts = rows
    .filter((r) => r.field && r.op && r.value.trim() !== '')
    .map((r) => {
      const literal = literalFor(r.type, r.value);
      return FUNCTION_OPS.has(r.op)
        ? `${r.op}(${r.field},${literal})`
        : `${r.field} ${r.op} ${literal}`;
    });
  return parts.join(` ${combinator} `);
}
