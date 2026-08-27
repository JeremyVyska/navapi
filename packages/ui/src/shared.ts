import {
  type BcRecord,
  type CachedRouteMetadata,
  companyLabel,
  type EntitySetInfo,
  type ProfileConfig,
} from '@navapi/core';

export interface GridCell {
  kind: 'empty' | 'text' | 'array' | 'object';
  text: string;
  nested?: GridData;
}

export interface GridData {
  columns: string[];
  rows: GridCell[][];
}

export interface FilterField {
  name: string;
  type: string;
  ops: string[];
}

export interface FilterRow {
  field: string;
  type: string;
  op: string;
  value: string;
}

export interface ItemPresentation {
  label: string;
  description?: string;
  tooltip: string;
}

const PREFERRED_COLUMNS = ['number', 'displayName', 'name', 'code', 'status', 'id'];
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

export function pickColumns(records: Record<string, unknown>[]): string[] {
  const keys: string[] = [];
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (key.startsWith('@') || keys.includes(key)) continue;
      keys.push(key);
    }
  }
  const preferred = PREFERRED_COLUMNS.filter((key) => keys.includes(key));
  return [...preferred, ...keys.filter((key) => !preferred.includes(key))];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function classifyCell(value: unknown): GridCell {
  if (value === null || value === undefined || value === '') {
    return { kind: 'empty', text: '' };
  }
  if (Array.isArray(value)) {
    return {
      kind: 'array',
      text: `${value.length} ${value.length === 1 ? 'item' : 'items'}`,
      nested: arrayGrid(value),
    };
  }
  if (isPlainObject(value)) {
    return { kind: 'object', text: '{…}', nested: recordGrid(value) };
  }
  return { kind: 'text', text: String(value) };
}

function arrayGrid(values: unknown[]): GridData {
  const objects = values.filter(isPlainObject);
  if (objects.length === values.length && values.length > 0) {
    return buildGrid(objects as BcRecord[]);
  }
  return { columns: ['value'], rows: values.map((value) => [classifyCell(value)]) };
}

export function recordGrid(value: Record<string, unknown>): GridData {
  const entries = Object.entries(value).filter(([key]) => !key.startsWith('@'));
  return {
    columns: ['field', 'value'],
    rows: entries.map(([key, entry]) => [
      { kind: 'text', text: key } as GridCell,
      classifyCell(entry),
    ]),
  };
}

export function buildGrid(records: BcRecord[]): GridData {
  const columns = pickColumns(records);
  return {
    columns,
    rows: records.map((record) => columns.map((column) => classifyCell(record[column]))),
  };
}

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

export function buildFilterExpression(rows: FilterRow[], combinator: 'and' | 'or' = 'and'): string {
  const parts = rows
    .filter((row) => row.field && row.op && row.value.trim() !== '')
    .map((row) => {
      const literal = literalFor(row.type, row.value);
      return FUNCTION_OPS.has(row.op)
        ? `${row.op}(${row.field},${literal})`
        : `${row.field} ${row.op} ${literal}`;
    });
  return parts.join(` ${combinator} `);
}

export function profileItem(profile: ProfileConfig, isDefault: boolean): ItemPresentation {
  const scope = [profile.environment, profile.company].filter(Boolean).join(' · ');
  return {
    label: profile.name,
    description: `${scope}${isDefault ? ' • default' : ''}`,
    tooltip: [
      `Profile: ${profile.name}${isDefault ? ' (default)' : ''}`,
      `Environment: ${profile.environment}`,
      `Tenant: ${profile.tenantId}`,
      profile.company ? `Company: ${profile.company}` : 'Company: (not set)',
    ].join('\n'),
  };
}

export function routeItem(route: CachedRouteMetadata): ItemPresentation {
  const count = route.metadata.entitySets.length;
  return {
    label: route.routePath,
    description: `${count} ${count === 1 ? 'entity set' : 'entity sets'}`,
    tooltip: `Route ${route.routePath}\nNamespace: ${route.metadata.namespace}\nMetadata fetched: ${route.fetchedAt}`,
  };
}

export function entitySetItem(entitySet: EntitySetInfo, lastCount?: number): ItemPresentation {
  const parts: string[] = [];
  if (lastCount !== undefined) parts.push(lastCount.toLocaleString('en-US'));
  if (entitySet.actions.length) parts.push(`⚡${entitySet.actions.length}`);
  return {
    label: entitySet.name,
    description: parts.join(' · ') || undefined,
    tooltip: [
      `${entitySet.name} (${entitySet.entityType})`,
      lastCount !== undefined
        ? `Last known count: ${lastCount.toLocaleString('en-US')}`
        : undefined,
      `Keys: ${entitySet.keys.join(', ') || '(none)'}`,
      `Properties: ${entitySet.properties.length}`,
      entitySet.navigationProperties.length
        ? `Navigation: ${entitySet.navigationProperties.map((nav) => nav.name).join(', ')}`
        : undefined,
      entitySet.actions.length ? `Bound actions: ${entitySet.actions.join(', ')}` : undefined,
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

export function companyItem(
  company: { id?: unknown; name?: unknown; displayName?: unknown },
  isDefault: boolean,
): ItemPresentation {
  const label = companyLabel(company as Record<string, unknown>);
  const internalName = String(company.name ?? '');
  return {
    label,
    description: `${internalName}${isDefault ? ' • default' : ''}`.trim() || undefined,
    tooltip: [
      label,
      internalName ? `Name: ${internalName}` : undefined,
      company.id ? `Id: ${company.id}` : undefined,
      isDefault ? 'Default company for this profile' : 'Click to make this the default company',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

export function schemaDocument(routePath: string, entitySet: EntitySetInfo): string {
  return JSON.stringify(
    {
      entitySet: entitySet.name,
      entityType: entitySet.entityType,
      route: routePath,
      keys: entitySet.keys,
      boundActions: entitySet.actions,
      properties: entitySet.properties,
      navigationProperties: entitySet.navigationProperties,
    },
    null,
    2,
  );
}

export function sortProfiles(profiles: ProfileConfig[], defaultProfile?: string): ProfileConfig[] {
  return [...profiles].sort((left, right) => {
    if (left.name === defaultProfile) return -1;
    if (right.name === defaultProfile) return 1;
    return left.name.localeCompare(right.name);
  });
}
