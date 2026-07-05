// @vitest-environment jsdom
/**
 * Executes the real Data Braider webview script in a DOM: paging buttons,
 * filter editor, nested-row expansion, and message posting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { braiderGrid } from '../src/braider-view.js';
import { type BraiderViewState, renderBraiderHtml } from '../src/braider-webview.js';

const posted: any[] = [];

function mountBraiderWebview(overrides: Partial<BraiderViewState> = {}): void {
  posted.length = 0;
  (window as any).acquireVsCodeApi = () => ({
    postMessage: (msg: unknown) => posted.push(msg),
  });
  const html = renderBraiderHtml(
    {
      title: 'CUSTOMERS · demo',
      code: 'CUSTOMERS',
      endpointType: 'Read Only',
      outputJsonType: 'Hierarchy',
      grid: braiderGrid([
        {
          level: 1,
          sourceTableNumber: 36,
          sourceTableName: 'SalesHeader',
          pkString: 'x',
          sourceSystemId: 'g1',
          data: { No: 'SO-1' },
          children: [
            {
              level: 2,
              sourceTableNumber: 37,
              sourceTableName: 'SalesLine',
              pkString: 'y',
              sourceSystemId: 'g2',
              data: { LineNo: 10000 },
              children: [],
            },
          ],
        },
      ]),
      recordCount: 1,
      topLevelRecordCount: 5,
      pageStart: 2,
      pageSize: 1,
      hasMore: true,
      filters: [{ table: 'Customer', field: 'No.', filter: '10000..20000' }],
      version: '0.1.0-test',
      ...overrides,
    },
    'TESTNONCE',
  );
  document.documentElement.innerHTML = html.replace(/^<!DOCTYPE html>\s*/i, '');
  const script = /<script nonce="TESTNONCE">([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!script) throw new Error('braider webview script not found');
  new Function(script)();
}

beforeEach(() => {
  vi.useFakeTimers();
  mountBraiderWebview();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('braider webview DOM behavior', () => {
  it('renders toolbar meta with type, format, and page info', () => {
    const meta = document.getElementById('meta')?.textContent ?? '';
    expect(meta).toContain('Read Only');
    expect(meta).toContain('Hierarchy');
    expect(meta).toContain('page 2');
    expect(document.getElementById('ver')?.textContent).toBe('v0.1.0-test');
  });

  it('paging buttons post load messages with adjusted pageStart', () => {
    document.getElementById('nextPage')?.dispatchEvent(new MouseEvent('click'));
    expect(posted.at(-1)).toMatchObject({ type: 'load', pageStart: 3, pageSize: 1 });
    document.getElementById('prevPage')?.dispatchEvent(new MouseEvent('click'));
    expect(posted.at(-1)).toMatchObject({ type: 'load', pageStart: 1 });
  });

  it('disables Prev on page 1 and Next when no more records', () => {
    mountBraiderWebview({ pageStart: 1, hasMore: false });
    expect((document.getElementById('prevPage') as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById('nextPage') as HTMLButtonElement).disabled).toBe(true);
  });

  it('seeds the filter editor from state and sends only complete rows', () => {
    const inputs = document.querySelectorAll<HTMLInputElement>('#frows input');
    expect(inputs[0].value).toBe('Customer');
    expect(inputs[1].value).toBe('No.');
    expect(inputs[2].value).toBe('10000..20000');
    // Existing filters auto-open the panel via a CSS class, never style.display.
    expect(document.getElementById('filterPanel')?.classList.contains('open')).toBe(true);

    document.getElementById('addRow')?.dispatchEvent(new MouseEvent('click'));
    document.getElementById('apply')?.dispatchEvent(new MouseEvent('click'));
    const msg = posted.at(-1);
    expect(msg.type).toBe('load');
    expect(msg.filters).toEqual([{ table: 'Customer', field: 'No.', filter: '10000..20000' }]); // blank row dropped
  });

  it('clearing filters posts a fresh page-1 load with none', () => {
    document.getElementById('clearFilters')?.dispatchEvent(new MouseEvent('click'));
    const msg = posted.at(-1);
    expect(msg).toMatchObject({ type: 'load', pageStart: 1, filters: [] });
    expect(document.querySelectorAll('#frows .frow')).toHaveLength(0);
  });

  it('expands hierarchy children as a nested sub-table on chip click', () => {
    const chip = document.querySelector<HTMLElement>('#root .chip');
    expect(chip?.textContent).toBe('1 item');
    chip?.dispatchEvent(new MouseEvent('click'));
    const nested = document.querySelector('#root .nestedrow');
    expect(nested).toBeTruthy();
    expect(nested?.textContent).toContain('10000');
    // Second click collapses.
    chip?.dispatchEvent(new MouseEvent('click'));
    expect(document.querySelector('#root .nestedrow')).toBeNull();
  });

  it('openJson posts the escape-hatch message', () => {
    document.getElementById('openJson')?.dispatchEvent(new MouseEvent('click'));
    expect(posted.at(-1)).toEqual({ type: 'openJson' });
  });

  it('shows the error banner text when the request failed', () => {
    mountBraiderWebview({
      error: 'Data Braider reported errors: boom',
      grid: { columns: [], rows: [] },
      recordCount: 0,
    });
    expect(document.getElementById('error')?.textContent).toContain('boom');
    expect(document.querySelector('#root .nothing')?.textContent).toBe('Request failed.');
  });
});
