/**
 * Pure grid model for the records webview — no vscode imports. Everything
 * the webview renders (including expandable sub-tables for $expand sublists
 * and nested objects) is precomputed here so it stays unit-testable; the
 * webview script only walks this structure.
 */
import type { BcRecord } from '@navapi/core';

export interface GridCell {
  kind: 'empty' | 'text' | 'array' | 'object';
  /** Display text: the value itself, or a chip label like "4 items". */
  text: string;
  /** Present for array/object cells: the expandable sub-table. */
  nested?: GridData;
}

export interface GridData {
  columns: string[];
  rows: GridCell[][];
}

const PREFERRED_COLUMNS = ['number', 'displayName', 'name', 'code', 'status', 'id'];

/** All record keys except @odata noise, well-known identity fields first. */
export function pickColumns(records: Record<string, unknown>[]): string[] {
  const keys: string[] = [];
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (key.startsWith('@') || keys.includes(key)) continue;
      keys.push(key);
    }
  }
  const preferred = PREFERRED_COLUMNS.filter((k) => keys.includes(k));
  return [...preferred, ...keys.filter((k) => !preferred.includes(k))];
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

/** Array cell → sub-table: object rows get real columns, scalars a single one. */
function arrayGrid(values: unknown[]): GridData {
  const objects = values.filter(isPlainObject);
  if (objects.length === values.length && values.length > 0) {
    return buildGrid(objects as BcRecord[]);
  }
  return { columns: ['value'], rows: values.map((v) => [classifyCell(v)]) };
}

/** Object → field/value table (values classified recursively). Also used for
 * single-valued navigation properties in the detail pane. */
export function recordGrid(value: Record<string, unknown>): GridData {
  const entries = Object.entries(value).filter(([k]) => !k.startsWith('@'));
  return {
    columns: ['field', 'value'],
    rows: entries.map(([k, v]) => [{ kind: 'text', text: k } as GridCell, classifyCell(v)]),
  };
}

export function buildGrid(records: BcRecord[]): GridData {
  const columns = pickColumns(records);
  return {
    columns,
    rows: records.map((record) => columns.map((col) => classifyCell(record[col]))),
  };
}
