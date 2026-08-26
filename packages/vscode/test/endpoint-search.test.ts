import type { CachedRouteMetadata, EntitySetInfo } from '@navapi/core';
import { describe, expect, it } from 'vitest';
import { endpointPickItems } from '../src/endpoint-search.js';

function entitySet(name: string, entityType: string): EntitySetInfo {
  return { name, entityType, keys: ['id'], properties: [], navigationProperties: [], actions: [] };
}

const cached: CachedRouteMetadata[] = [
  {
    routePath: 'v2.0',
    fetchedAt: '2026-01-01T00:00:00.000Z',
    metadata: {
      namespace: 'Microsoft.NAV',
      entitySets: [entitySet('customers', 'Microsoft.NAV.customer')],
    },
  },
  {
    routePath: 'contoso/fieldops/v1.0',
    fetchedAt: '2026-01-01T00:00:00.000Z',
    metadata: {
      namespace: 'Contoso.FieldOps',
      entitySets: [entitySet('workOrders', 'Contoso.FieldOps.workOrderEntity')],
    },
  },
];

describe('endpointPickItems', () => {
  it('shows the name, the route it lives on, and its entity type', () => {
    expect(endpointPickItems('contoso-prod', cached)[0]).toEqual({
      label: 'customers',
      description: 'v2.0',
      detail: 'Microsoft.NAV.customer',
      node: {
        kind: 'entitySet',
        profileName: 'contoso-prod',
        routePath: 'v2.0',
        entitySet: cached[0].metadata.entitySets[0],
      },
    });
  });

  it('flattens every route, because the quick pick does its own filtering', () => {
    expect(endpointPickItems('contoso-prod', cached).map((i) => i.label)).toEqual([
      'customers',
      'workOrders',
    ]);
  });

  it('produces a node the openEntity command can use as-is', () => {
    const [, workOrders] = endpointPickItems('contoso-prod', cached);
    expect(workOrders.node.routePath).toBe('contoso/fieldops/v1.0');
    expect(workOrders.node.entitySet.name).toBe('workOrders');
  });

  it('has nothing to show before discovery has run', () => {
    expect(endpointPickItems('contoso-prod', [])).toEqual([]);
  });
});
