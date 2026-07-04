import type { EntitySetInfo, ProfileConfig } from '@navapi/core';
import { describe, expect, it } from 'vitest';
import {
  companyItem,
  entitySetItem,
  profileItem,
  routeItem,
  schemaDocument,
  sortProfiles,
} from '../src/model.js';

const PROFILE: ProfileConfig = {
  name: 'contoso-prod',
  tenantId: 'tenant-1',
  clientId: 'client-1',
  environment: 'Production',
  company: 'CRONUS',
};

const ENTITY: EntitySetInfo = {
  name: 'salesOrders',
  entityType: 'Microsoft.NAV.salesOrder',
  keys: ['id'],
  properties: [
    { name: 'id', type: 'Edm.Guid', nullable: false },
    { name: 'number', type: 'Edm.String', nullable: true, maxLength: 20 },
  ],
  navigationProperties: [{ name: 'customer', type: 'Microsoft.NAV.customer' }],
  actions: ['shipAndInvoice', 'Microsoft.NAV.Release'],
};

describe('profileItem', () => {
  it('marks the default profile and includes environment + company', () => {
    const info = profileItem(PROFILE, true);
    expect(info.label).toBe('contoso-prod');
    expect(info.description).toBe('Production · CRONUS • default');
    expect(info.tooltip).toContain('Tenant: tenant-1');
    expect(info.tooltip).toContain('Company: CRONUS');
  });

  it('handles non-default profiles without a company', () => {
    const info = profileItem({ ...PROFILE, company: undefined }, false);
    expect(info.description).toBe('Production');
    expect(info.tooltip).toContain('Company: (not set)');
  });
});

describe('routeItem', () => {
  it('summarizes entity set count with pluralization', () => {
    const one = routeItem({
      routePath: 'v2.0',
      fetchedAt: '2026-07-04T10:00:00Z',
      metadata: { namespace: 'Microsoft.NAV', entitySets: [ENTITY] },
    });
    expect(one.description).toBe('1 entity set');
    expect(one.tooltip).toContain('Namespace: Microsoft.NAV');
  });
});

describe('entitySetItem', () => {
  it('shows the last-known count next to the action badge', () => {
    const info = entitySetItem(ENTITY, 1203);
    expect(info.description).toBe('1,203 · ⚡2');
    expect(info.tooltip).toContain('Last known count: 1,203');
    const noActions = entitySetItem({ ...ENTITY, actions: [] }, 7);
    expect(noActions.description).toBe('7');
  });

  it('shows an action badge and a rich tooltip', () => {
    const info = entitySetItem(ENTITY);
    expect(info.label).toBe('salesOrders');
    expect(info.description).toBe('⚡2');
    expect(info.tooltip).toContain('Keys: id');
    expect(info.tooltip).toContain('Bound actions: shipAndInvoice, Microsoft.NAV.Release');
    expect(info.tooltip).toContain('Navigation: customer');
  });

  it('omits the badge when there are no actions', () => {
    const info = entitySetItem({ ...ENTITY, actions: [], navigationProperties: [] });
    expect(info.description).toBeUndefined();
    expect(info.tooltip).not.toContain('Bound actions');
  });
});

describe('companyItem', () => {
  const company = { id: 'guid-1', name: 'CRONUS', displayName: 'CRONUS International Ltd.' };

  it('marks the default company', () => {
    const info = companyItem(company, true);
    expect(info.label).toBe('CRONUS International Ltd.');
    expect(info.description).toBe('CRONUS • default');
    expect(info.tooltip).toContain('Default company for this profile');
  });

  it('invites switching when not default and falls back through names', () => {
    const info = companyItem(company, false);
    expect(info.description).toBe('CRONUS');
    expect(info.tooltip).toContain('Click to make this the default');
    expect(companyItem({ id: 'x' }, false).label).toBe('x');
    expect(companyItem({}, false).label).toBe('(unnamed)');
  });
});

describe('schemaDocument', () => {
  it('produces stable, parseable JSON', () => {
    const doc = JSON.parse(schemaDocument('v2.0', ENTITY));
    expect(doc).toMatchObject({
      entitySet: 'salesOrders',
      route: 'v2.0',
      keys: ['id'],
      boundActions: ['shipAndInvoice', 'Microsoft.NAV.Release'],
    });
    expect(doc.properties).toHaveLength(2);
  });
});

describe('sortProfiles', () => {
  it('puts the default first, then alphabetical', () => {
    const profiles = [
      { ...PROFILE, name: 'zeta' },
      { ...PROFILE, name: 'alpha' },
      { ...PROFILE, name: 'middle' },
    ];
    expect(sortProfiles(profiles, 'middle').map((p) => p.name)).toEqual([
      'middle',
      'alpha',
      'zeta',
    ]);
    expect(sortProfiles(profiles).map((p) => p.name)).toEqual(['alpha', 'middle', 'zeta']);
  });
});
