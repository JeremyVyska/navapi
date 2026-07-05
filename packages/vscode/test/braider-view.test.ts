import { describe, expect, it } from 'vitest';
import {
  braiderEndpointIcon,
  braiderEndpointItem,
  braiderGrid,
  braiderRows,
} from '../src/braider-view.js';

const NODE = {
  level: 1,
  sourceTableNumber: 36,
  sourceTableName: 'SalesHeader',
  pkString: 'x',
  sourceSystemId: 'g1',
  data: { No: 'SO-1', Amount: 100 },
  children: [
    {
      level: 2,
      sourceTableNumber: 37,
      sourceTableName: 'SalesLine',
      pkString: 'y',
      sourceSystemId: 'g2',
      data: { LineNo: 10000, Amount: 50 },
      children: [],
    },
  ],
};

describe('braiderRows', () => {
  it('passes flat records through untouched', () => {
    const flat = [{ 'Customer.No': '10000', 'Customer.Name': 'Adatum' }];
    expect(braiderRows(flat)).toEqual(flat);
  });

  it('flattens hierarchy nodes to data + recursive children', () => {
    const rows = braiderRows([NODE]);
    expect(rows).toEqual([
      {
        No: 'SO-1',
        Amount: 100,
        children: [{ LineNo: 10000, Amount: 50 }],
      },
    ]);
  });

  it('omits the children key for leaf nodes', () => {
    const rows = braiderRows([{ ...NODE, children: [] }]);
    expect(rows[0]).not.toHaveProperty('children');
  });

  it('braiderGrid turns children into expandable nested sub-tables', () => {
    const grid = braiderGrid([NODE]);
    expect(grid.columns).toContain('No');
    expect(grid.columns).toContain('children');
    const childCell = grid.rows[0][grid.columns.indexOf('children')];
    expect(childCell.kind).toBe('array');
    expect(childCell.nested?.columns).toEqual(expect.arrayContaining(['LineNo', 'Amount']));
  });
});

describe('braider endpoint presentation', () => {
  it('labels with code and describes type/output', () => {
    const info = braiderEndpointItem({
      code: 'CUSTOMERS',
      description: 'All customers',
      endpointType: 'Read Only',
      outputJsonType: 'Flat',
      topLevelRecordCount: 42,
    });
    expect(info.label).toBe('CUSTOMERS');
    expect(info.description).toBe('Read Only · Flat');
    expect(info.tooltip).toContain('All customers');
    expect(info.tooltip).toContain('42');
  });

  it('maps endpoint types to distinct icons', () => {
    expect(braiderEndpointIcon('Read Only')).toBe('eye');
    expect(braiderEndpointIcon('Per Record')).toBe('pencil');
    expect(braiderEndpointIcon('Batch')).toBe('files');
    expect(braiderEndpointIcon('Delta Read')).toBe('history');
    expect(braiderEndpointIcon('Whatever')).toBe('plug');
  });
});
