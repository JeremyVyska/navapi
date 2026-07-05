/**
 * Pure presentation logic for the Data Braider section — no vscode imports,
 * unit-tested in jsdom/node. Hierarchy nodes flatten into grid-friendly rows
 * whose `children` arrays become expandable sub-tables via grid.ts.
 */
import type {
  BcRecord,
  BraiderEndpoint,
  BraiderEndpointSchema,
  BraiderHierarchyNode,
} from '@navapi/core';
import { buildGrid, type GridData } from './grid.js';
import type { ItemPresentation } from './model.js';

export function isHierarchyNode(record: unknown): record is BraiderHierarchyNode {
  return (
    typeof record === 'object' && record !== null && 'data' in record && 'sourceTableName' in record
  );
}

function flattenNode(node: BraiderHierarchyNode): BcRecord {
  const row: BcRecord = { ...node.data };
  if (node.children?.length) {
    row.children = node.children.map(flattenNode);
  }
  return row;
}

/** Braider read records → grid rows (hierarchy nodes flattened recursively). */
export function braiderRows(records: unknown[]): BcRecord[] {
  return records.map((r) => (isHierarchyNode(r) ? flattenNode(r) : ((r ?? {}) as BcRecord)));
}

export function braiderGrid(records: unknown[]): GridData {
  return buildGrid(braiderRows(records));
}

const TYPE_ICONS: Record<string, string> = {
  'Read Only': 'eye',
  'Per Record': 'pencil',
  Batch: 'files',
  'Delta Read': 'history',
};

export function braiderEndpointIcon(endpointType: string): string {
  return TYPE_ICONS[endpointType] ?? 'plug';
}

export function braiderEndpointItem(endpoint: BraiderEndpoint): ItemPresentation {
  return {
    label: endpoint.code,
    description:
      [endpoint.endpointType, endpoint.outputJsonType].filter(Boolean).join(' · ') || undefined,
    tooltip: [
      `${endpoint.code}${endpoint.description ? ` — ${endpoint.description}` : ''}`,
      `Type: ${endpoint.endpointType}`,
      `Output: ${endpoint.outputJsonType}`,
      endpoint.topLevelRecordCount !== undefined
        ? `Last known top-level records: ${endpoint.topLevelRecordCount.toLocaleString('en-US')}`
        : undefined,
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

/** Schema document for "Show Schema" on a Braider endpoint. */
export function braiderSchemaDocument(schema: BraiderEndpointSchema): string {
  return JSON.stringify(schema, null, 2);
}
