/**
 * Pure item building for the Endpoint Browser search — no vscode imports, so
 * it can be unit-tested without an extension host.
 */
import { type CachedRouteMetadata, searchEntitySets } from '@navapi/core';
import type { EntitySetNode } from './tree.js';

/**
 * One quick pick row. Structurally a `vscode.QuickPickItem` plus the node the
 * Endpoint Browser would have produced for the same entity set, so accepting a
 * row can open records through the existing `navapi.openEntity` command.
 */
export interface EndpointPickItem {
  label: string;
  description: string;
  detail: string;
  node: EntitySetNode;
}

/**
 * Every cached entity set as a pick row, in route order.
 *
 * The quick pick does its own filtering, so this deliberately returns the
 * whole list. The entity type goes in `detail` and the route in `description`
 * — with `matchOnDetail` and `matchOnDescription` set, that makes all three
 * names searchable.
 */
export function endpointPickItems(
  profileName: string,
  cached: CachedRouteMetadata[],
): EndpointPickItem[] {
  return searchEntitySets(cached).map(({ route, entitySet }) => ({
    label: entitySet.name,
    description: route,
    detail: entitySet.entityType,
    node: { kind: 'entitySet', profileName, routePath: route, entitySet },
  }));
}
