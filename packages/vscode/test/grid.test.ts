import { describe, expect, it } from 'vitest';
import { buildGrid, classifyCell, pickColumns, recordGrid } from '../src/grid.js';
import { getNonce, renderRecordsHtml } from '../src/webview.js';

describe('pickColumns', () => {
  it('drops @odata keys and puts identity columns first', () => {
    const cols = pickColumns([
      { '@odata.etag': 'x', zzz: 1, displayName: 'A', number: '10000' },
      { extra: true, id: 'guid' },
    ]);
    expect(cols).toEqual(['number', 'displayName', 'id', 'zzz', 'extra']);
  });
});

describe('classifyCell', () => {
  it('classifies scalars, empties, and booleans', () => {
    expect(classifyCell('Open')).toEqual({ kind: 'text', text: 'Open' });
    expect(classifyCell(0)).toEqual({ kind: 'text', text: '0' });
    expect(classifyCell(false)).toEqual({ kind: 'text', text: 'false' });
    expect(classifyCell(null)).toEqual({ kind: 'empty', text: '' });
    expect(classifyCell('')).toEqual({ kind: 'empty', text: '' });
  });

  it('turns an array of objects into a chip with a real sub-grid', () => {
    const cell = classifyCell([
      { lineNo: 10000, description: 'Bicycle', quantity: 2 },
      { lineNo: 20000, description: 'Chain', quantity: 5 },
    ]);
    expect(cell.kind).toBe('array');
    expect(cell.text).toBe('2 items');
    expect(cell.nested?.columns).toEqual(['lineNo', 'description', 'quantity']);
    expect(cell.nested?.rows).toHaveLength(2);
    expect(cell.nested?.rows[0][1]).toEqual({ kind: 'text', text: 'Bicycle' });
  });

  it('turns scalar arrays into a single-column sub-grid', () => {
    const cell = classifyCell(['a', 'b']);
    expect(cell.nested?.columns).toEqual(['value']);
    expect(cell.nested?.rows.map((r) => r[0].text)).toEqual(['a', 'b']);
  });

  it('turns objects into field/value sub-grids, recursively', () => {
    const cell = classifyCell({
      code: 'USD',
      '@odata.context': 'noise',
      amounts: [{ value: 1 }],
    });
    expect(cell.kind).toBe('object');
    expect(cell.nested?.columns).toEqual(['field', 'value']);
    const rows = cell.nested?.rows ?? [];
    expect(rows.map((r) => r[0].text)).toEqual(['code', 'amounts']);
    expect(rows[1][1].kind).toBe('array');
    expect(rows[1][1].nested?.columns).toEqual(['value']);
  });
});

describe('buildGrid', () => {
  it('builds rows in column order, handling $expand sublists', () => {
    const grid = buildGrid([
      {
        number: 'SO-1001',
        status: 'Open',
        salesOrderLines: [{ lineNo: 10000 }],
      },
      { number: 'SO-1002', status: 'Released', salesOrderLines: [] },
    ]);
    expect(grid.columns).toEqual(['number', 'status', 'salesOrderLines']);
    expect(grid.rows[0][2].kind).toBe('array');
    expect(grid.rows[0][2].text).toBe('1 item');
    expect(grid.rows[1][2].text).toBe('0 items');
  });
});

describe('recordGrid', () => {
  it('renders a record as field/value rows, skipping @odata noise', () => {
    const g = recordGrid({ '@odata.etag': 'x', code: 'USD', amounts: [1, 2] });
    expect(g.columns).toEqual(['field', 'value']);
    expect(g.rows.map((r) => r[0].text)).toEqual(['code', 'amounts']);
    expect(g.rows[1][1].kind).toBe('array');
  });
});

describe('renderRecordsHtml', () => {
  const state = {
    title: 'customers · v2.0 · demo',
    grid: buildGrid([{ number: '10000', note: '</script><img src=x onerror=alert(1)>' }]),
    count: 1,
    totalCount: 1203,
    hasMore: true,
    fields: [{ name: 'number', type: 'Edm.String', ops: ['contains', 'eq'] }],
    navProps: ['currency', 'shipments'],
    filter: '',
    select: [],
    orderby: null,
    queryUrl: 'https://api.example/api/v2.0/companies(x)/customers?$top=50&$count=true',
    version: '0.0.1-test',
  };

  it('embeds data without any closeable script tag', () => {
    const html = renderRecordsHtml(state, 'NONCE123');
    expect(html).toContain('nonce="NONCE123"');
    expect(html).toContain('\\u003c/script'); // escaped payload
    // The only literal "</script>" left is the document's own closing tag.
    expect(html.split('</script>')).toHaveLength(2);
  });

  it('carries state and CSP', () => {
    const html = renderRecordsHtml(state, 'N');
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain('"hasMore":true');
    expect(html).toContain('customers · v2.0 · demo');
  });

  it('includes the query panel wired to the schema fields', () => {
    const html = renderRecordsHtml(state, 'N');
    expect(html).toContain('id="filterPanel"');
    expect(html).toContain('applyQuery');
    expect(html).toContain('previewFilter');
    expect(html).toContain('"ops":["contains","eq"]');
    // sticky header pins inside its own scroll container, no magic offsets
    expect(html).toContain('position: sticky; top: 0;');
    expect(html).not.toContain('top: 42px');
  });

  it('carries $select picks, the total count, and the query URL', () => {
    const html = renderRecordsHtml(state, 'N');
    expect(html).toContain('id="fieldPicks"');
    expect(html).toContain('id="queryUrl"');
    expect(html).toContain('copyUrl');
    expect(html).toContain('"totalCount":1203');
    expect(html).toContain('customers?$top=50&$count=true');
  });

  it('includes the FastTab detail pane wired to navigation properties', () => {
    const html = renderRecordsHtml(state, 'N');
    expect(html).toContain('id="detailPane"');
    expect(html).toContain('fetchNav');
    expect(html).toContain('navResult');
    expect(html).toContain('"navProps":["currency","shipments"]');
  });
});

describe('getNonce', () => {
  it('returns 32 alphanumeric chars, unique-ish', () => {
    const a = getNonce();
    expect(a).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(getNonce()).not.toBe(a);
  });
});
