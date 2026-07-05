// @vitest-environment jsdom
/**
 * Runs the real webview HTML + script in a DOM, so behavior bugs (like a
 * detail pane that never becomes visible) fail here instead of in VS Code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGrid } from '../src/grid.js';
import { renderRecordsHtml } from '../src/webview.js';

const posted: any[] = [];

function mountWebview(overrides: Record<string, unknown> = {}): void {
  posted.length = 0;
  (window as any).acquireVsCodeApi = () => ({
    postMessage: (msg: unknown) => posted.push(msg),
  });
  const html = renderRecordsHtml(
    {
      title: 'customers · v2.0 · demo',
      grid: buildGrid([
        { id: 'guid-1', number: '10000', displayName: 'Adatum', shipments: [{ number: 'SH-1' }] },
        { id: 'guid-2', number: '20000', displayName: 'Trey' },
      ]),
      count: 2,
      totalCount: 2,
      hasMore: false,
      fields: [
        { name: 'number', type: 'Edm.String', ops: ['contains', 'eq'] },
        { name: 'displayName', type: 'Edm.String', ops: ['contains', 'eq'] },
      ],
      navProps: ['currency', 'shipments'],
      filter: '',
      select: [],
      orderby: null,
      queryUrl: 'https://x.example/api/v2.0/companies(c)/customers?$top=50&$count=true',
      version: '0.0.1-test',
      ...overrides,
    },
    'TESTNONCE',
  );
  document.documentElement.innerHTML = html.replace(/^<!DOCTYPE html>\s*/i, '');
  const script = /<script nonce="TESTNONCE">([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!script) throw new Error('webview script not found');
  new Function(script)(); // executes the webview's own script under test
}

function rowsInGrid(): HTMLTableRowElement[] {
  return [...document.querySelectorAll<HTMLTableRowElement>('#root table tbody tr')];
}

beforeEach(() => {
  // Fake timers so the webview's debounce timers (filter preview) can't fire
  // after jsdom teardown — that surfaces as an unhandled "document is not
  // defined" error at the end of the run.
  vi.useFakeTimers();
  mountWebview();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('records webview DOM behavior', () => {
  it('renders the grid rows and toolbar meta with x of Y', () => {
    expect(rowsInGrid()).toHaveLength(2);
    expect(document.getElementById('meta')?.textContent).toContain('2 record');
    expect((document.getElementById('queryUrl') as HTMLInputElement).value).toContain(
      '$count=true',
    );
    // Version stamp makes stale installs diagnosable at a glance.
    expect(document.getElementById('ver')?.textContent).toBe('v0.0.1-test');
  });

  it('clicking a row opens the detail pane with General + nav FastTabs', () => {
    const pane = document.getElementById('detailPane') as HTMLElement;
    expect(getComputedStyle(pane).display).toBe('none');

    rowsInGrid()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(pane.classList.contains('open')).toBe(true);
    expect(getComputedStyle(pane).display).not.toBe('none');
    expect(document.getElementById('dtitle')?.textContent).toContain('10000');

    const tabNames = [...document.querySelectorAll('#dtabs .fhead')].map((h) => h.textContent);
    expect(tabNames?.[0]).toContain('General');
    expect(tabNames?.some((t) => t?.includes('currency'))).toBe(true);
    expect(tabNames?.some((t) => t?.includes('shipments'))).toBe(true);

    // General is open by default and shows record fields.
    const general = document.querySelector('#dtabs .ftab.open .fbody');
    expect(general?.textContent).toContain('displayName');
    expect(general?.textContent).toContain('Adatum');
  });

  it('expanding a nav tab lazily requests it, then renders the result', () => {
    rowsInGrid()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const shipHead = [...document.querySelectorAll('#dtabs .fhead')].find((h) =>
      h.textContent?.includes('shipments'),
    ) as HTMLElement;
    shipHead.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(posted).toContainEqual({ type: 'fetchNav', rowIndex: 0, nav: 'shipments' });

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'navResult',
          rowIndex: 0,
          nav: 'shipments',
          kind: 'collection',
          count: 1,
          grid: buildGrid([{ number: 'SH-1', status: 'Posted' }]),
        },
      }),
    );

    const heads = [...document.querySelectorAll('#dtabs .fhead')];
    const shipHeadAfter = heads.find((h) => h.textContent?.includes('shipments'));
    expect(shipHeadAfter?.textContent).toContain('(1)');
    const openBodies = [...document.querySelectorAll('#dtabs .ftab.open .fbody')];
    expect(openBodies.some((b) => b.textContent?.includes('SH-1'))).toBe(true);
  });

  it('Escape closes the pane; clicking the same row toggles it', () => {
    const pane = document.getElementById('detailPane') as HTMLElement;
    rowsInGrid()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(pane.classList.contains('open')).toBe(true);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(pane.classList.contains('open')).toBe(false);

    rowsInGrid()[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(pane.classList.contains('open')).toBe(true);
    rowsInGrid()[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(pane.classList.contains('open')).toBe(false);
  });

  it('clicking a sublist chip expands inline and does not select the row', () => {
    const pane = document.getElementById('detailPane') as HTMLElement;
    const chip = document.querySelector('#root .chip') as HTMLElement;
    chip.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(pane.classList.contains('open')).toBe(false);
    expect(document.querySelector('#root td.detail')?.textContent).toContain('SH-1');
  });

  it('sorts locally when the whole dataset is loaded', () => {
    const th = [...document.querySelectorAll('#root th')].find(
      (h) => h.textContent === 'number',
    ) as HTMLElement;
    th.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    th.dispatchEvent(new MouseEvent('click', { bubbles: true })); // descending
    const firstCell = document.querySelector('#root tbody tr td');
    expect(firstCell?.textContent).toBe('20000');
    expect(posted.some((m) => m.type === 'sortBy')).toBe(false);
  });

  it('requests server-side $orderby when only part of the data is loaded', () => {
    mountWebview({ hasMore: true, totalCount: 1203 });
    const th = [...document.querySelectorAll('#root th')].find(
      (h) => h.textContent === 'number',
    ) as HTMLElement;
    th.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(posted).toContainEqual({ type: 'sortBy', field: 'number', dir: 'asc' });
    // Rows must NOT be reordered locally — that would show a fake "top 50".
    expect(document.querySelector('#root tbody tr td')?.textContent).toBe('10000');
  });

  it('shows the server sort direction and toggles it on the next click', () => {
    mountWebview({ hasMore: true, orderby: { field: 'number', dir: 'asc' } });
    const th = [...document.querySelectorAll('#root th')].find((h) =>
      h.textContent?.startsWith('number'),
    ) as HTMLElement;
    expect(th.textContent).toContain('▲');
    th.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(posted).toContainEqual({ type: 'sortBy', field: 'number', dir: 'desc' });
  });

  it('keeps local sorting for non-property (expanded) columns even when partial', () => {
    mountWebview({ hasMore: true });
    const th = [...document.querySelectorAll('#root th')].find(
      (h) => h.textContent === 'shipments',
    ) as HTMLElement;
    th.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(posted.some((m) => m.type === 'sortBy')).toBe(false);
  });

  function rightClickCell(row: number, cellIndex: number): void {
    const td = rowsInGrid()[row].children[cellIndex] as HTMLElement;
    td.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
  }

  function menuItems(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>('#ctxMenu .mi')];
  }

  it('right-click on a property cell opens the BC-style menu', () => {
    rightClickCell(0, 1); // displayName column
    const menu = document.getElementById('ctxMenu') as HTMLElement;
    expect(menu.classList.contains('open')).toBe(true);
    expect(menuItems().map((m) => m.textContent)).toEqual([
      'Filter…',
      'Filter to This Value',
      'Copy Value',
    ]);
  });

  it('"Copy Value" sends the cell text to the extension clipboard handler', () => {
    rightClickCell(0, 1);
    menuItems()[2].click();
    expect(posted).toContainEqual({ type: 'copyValue', text: 'Adatum' });
  });

  it('"Filter…" opens the query panel with the field pre-picked, no requery', () => {
    rightClickCell(0, 1);
    menuItems()[0].click();
    expect(document.getElementById('filterPanel')?.classList.contains('open')).toBe(true);
    const fieldSel = document.querySelector('#frows .frow select.field') as HTMLSelectElement;
    expect(fieldSel.value).toBe('displayName');
    expect(posted.some((m) => m.type === 'applyQuery')).toBe(false);
    expect(document.getElementById('ctxMenu')?.classList.contains('open')).toBe(false);
  });

  it('"Filter to This Value" fills field + eq + value and applies immediately', () => {
    rightClickCell(0, 1); // Adatum cell
    menuItems()[1].click();
    const apply = posted.find((m) => m.type === 'applyQuery');
    expect(apply?.rows).toEqual([
      { field: 'displayName', type: 'Edm.String', op: 'eq', value: 'Adatum' },
    ]);
    expect(document.getElementById('filterPanel')?.classList.contains('open')).toBe(true);
  });

  it('no menu on non-property columns; disabled value item on chips', () => {
    rightClickCell(0, 2); // id column — not in fields
    expect(document.getElementById('ctxMenu')?.classList.contains('open')).toBe(false);

    mountWebview({
      fields: [{ name: 'shipments', type: 'Edm.String', ops: ['contains', 'eq'] }],
    });
    const shipmentsIdx = 3; // number, displayName, id, shipments
    rightClickCell(0, shipmentsIdx);
    const items = menuItems();
    expect(items[1].classList.contains('disabled')).toBe(true);
    items[1].click();
    expect(posted.some((m) => m.type === 'applyQuery')).toBe(false);
  });

  it('meta shows (filtered) with the count when a filter is applied', () => {
    mountWebview({ filter: "displayName eq 'Adatum'", totalCount: 37, count: 2, hasMore: true });
    expect(document.getElementById('meta')?.textContent).toContain('2 of 37 records (filtered)');
  });
});
