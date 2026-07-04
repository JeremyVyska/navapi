import { describe, expect, it } from 'vitest';
import { parseMetadata } from '../src/index.js';
import { SAMPLE_EDMX } from './fixtures/edmx.js';

describe('parseMetadata', () => {
  const meta = parseMetadata(SAMPLE_EDMX);

  it('extracts the namespace and all entity sets, sorted', () => {
    expect(meta.namespace).toBe('Microsoft.NAV');
    expect(meta.entitySets.map((e) => e.name)).toEqual([
      'companies',
      'currencies',
      'customers',
      'salesOrders',
    ]);
  });

  it('extracts keys, properties, and maxLength', () => {
    const customer = meta.entitySets.find((e) => e.name === 'customers');
    expect(customer).toBeDefined();
    expect(customer?.entityType).toBe('Microsoft.NAV.customer');
    expect(customer?.keys).toEqual(['id']);
    const number = customer?.properties.find((p) => p.name === 'number');
    expect(number).toMatchObject({ type: 'Edm.String', maxLength: 20, nullable: true });
    const id = customer?.properties.find((p) => p.name === 'id');
    expect(id).toMatchObject({ type: 'Edm.Guid', nullable: false });
  });

  it('extracts navigation properties', () => {
    const customer = meta.entitySets.find((e) => e.name === 'customers');
    expect(customer?.navigationProperties).toEqual([
      { name: 'currency', type: 'Microsoft.NAV.currency' },
    ]);
  });

  it('maps bound actions to their entity sets', () => {
    const orders = meta.entitySets.find((e) => e.name === 'salesOrders');
    expect(orders?.actions).toEqual(['shipAndInvoice', 'Microsoft.NAV.Release']);
    const customers = meta.entitySets.find((e) => e.name === 'customers');
    expect(customers?.actions).toEqual([]);
  });

  it('rejects non-metadata documents', () => {
    expect(() => parseMetadata('<html><body>login page</body></html>')).toThrow(/no <Schema>/);
  });
});
