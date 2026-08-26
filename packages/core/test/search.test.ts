import { describe, expect, it } from 'vitest';
import { searchEntitySets } from '../src/search.js';
import type { CachedRouteMetadata, EntitySetInfo } from '../src/types.js';

function entitySet(name: string, entityType: string): EntitySetInfo {
  return { name, entityType, keys: ['id'], properties: [], navigationProperties: [], actions: [] };
}

function route(routePath: string, sets: EntitySetInfo[]): CachedRouteMetadata {
  return {
    routePath,
    fetchedAt: '2026-01-01T00:00:00.000Z',
    metadata: { namespace: 'Microsoft.NAV', entitySets: sets },
  };
}

const cached: CachedRouteMetadata[] = [
  route('v2.0', [
    entitySet('customers', 'Microsoft.NAV.customer'),
    entitySet('salesOrders', 'Microsoft.NAV.salesOrder'),
  ]),
  route('contoso/fieldops/v1.0', [entitySet('workOrders', 'Contoso.FieldOps.workOrderEntity')]),
];

describe('searchEntitySets', () => {
  it('matches entity set names regardless of case', () => {
    expect(searchEntitySets(cached, 'CUSTOM').map((m) => m.entitySet.name)).toEqual(['customers']);
  });

  it('matches the entity type too, which is the name AL source uses', () => {
    const matches = searchEntitySets(cached, 'workOrderEntity');
    expect(matches).toEqual([
      { route: 'contoso/fieldops/v1.0', entitySet: cached[1].metadata.entitySets[0] },
    ]);
  });

  it('matches a qualified type pasted out of AL or an error message', () => {
    expect(
      searchEntitySets(cached, 'Microsoft.NAV.salesOrder').map((m) => m.entitySet.name),
    ).toEqual(['salesOrders']);
  });

  it('does not let a namespace match everything under it', () => {
    // Every standard type is `Microsoft.NAV.*`; matching the qualified name
    // would turn these terms into "return the whole environment".
    expect(searchEntitySets(cached, 'nav')).toEqual([]);
    expect(searchEntitySets(cached, 'microsoft')).toEqual([]);
  });

  it('carries the route each match came from', () => {
    expect(searchEntitySets(cached, 'order').map((m) => m.route)).toEqual([
      'v2.0',
      'contoso/fieldops/v1.0',
    ]);
  });

  it('returns everything when there is no term, so listing and searching share a path', () => {
    expect(searchEntitySets(cached)).toHaveLength(3);
    expect(searchEntitySets(cached, '   ')).toHaveLength(3);
  });

  it('returns nothing when nothing matches', () => {
    expect(searchEntitySets(cached, 'nosuchthing')).toEqual([]);
  });
});
