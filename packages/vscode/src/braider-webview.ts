/**
 * Data Braider records webview: HTML + embedded script, pure (no vscode
 * imports) so jsdom tests execute the real script. House rules apply:
 * CSS-class toggling only, record data rendered DOM-only (XSS-safe).
 */
import type { BraiderFilter } from '@navapi/core';
import type { GridData } from './grid.js';

export interface BraiderViewState {
  title: string;
  code: string;
  endpointType: string;
  outputJsonType: string;
  grid: GridData;
  /** Parsed records shown (rows in the grid). */
  recordCount: number;
  topLevelRecordCount?: number;
  pageStart: number;
  pageSize?: number;
  hasMore: boolean;
  filters: BraiderFilter[];
  error?: string;
  version: string;
}

/** JSON safe to embed inside a <script> element. */
function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028')
    .replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029');
}

export function renderBraiderHtml(state: BraiderViewState, nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  html, body { height: 100%; margin: 0; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); display: flex; flex-direction: column; overflow: hidden; }
  .toolbar { flex: 0 0 auto; display: flex; gap: 8px; align-items: center; padding: 10px 12px; }
  .toolbar h1 { font-size: 13px; font-weight: 600; margin: 0 auto 0 0; }
  .toolbar .meta { color: var(--vscode-descriptionForeground); font-size: 12px; }
  button { background: var(--vscode-button-secondaryBackground, var(--vscode-button-background)); color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground)); border: none; padding: 4px 10px; border-radius: 2px; cursor: pointer; font-size: 12px; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground)); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button:disabled { opacity: .5; cursor: default; }

  #filterPanel { flex: 0 0 auto; display: none; padding: 4px 12px 10px; border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,.25)); }
  #filterPanel.open { display: block; }
  .frow { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; }
  .frow input { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 3px 6px; border-radius: 2px; font-size: 12px; }
  .frow input.tbl { width: 160px; }
  .frow input.fld { width: 160px; }
  .frow input.flt { flex: 1; }
  .factions { display: flex; gap: 8px; align-items: center; margin-top: 6px; }
  .factions .spacer { margin-left: auto; }
  .factions label { font-size: 12px; color: var(--vscode-descriptionForeground); display: inline-flex; align-items: center; gap: 4px; }
  .factions input.pg { width: 64px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 3px 6px; border-radius: 2px; font-size: 12px; }
  .hint { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px; }

  #error { color: var(--vscode-errorForeground); font-size: 12px; padding: 0 12px; white-space: pre-wrap; }
  #error:empty { display: none; }

  .wrap { flex: 1 1 auto; overflow: auto; padding: 0 12px 12px; }
  table { border-collapse: collapse; font-size: 12px; width: max-content; min-width: 100%; }
  th, td { text-align: left; padding: 4px 10px; border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,.2)); white-space: nowrap; max-width: 340px; overflow: hidden; text-overflow: ellipsis; }
  th { position: sticky; top: 0; z-index: 1; background: var(--vscode-editor-background); font-weight: 600; color: var(--vscode-descriptionForeground); box-shadow: 0 1px 0 var(--vscode-editorWidget-border, rgba(128,128,128,.25)); }
  tbody tr:hover { background: var(--vscode-list-hoverBackground); }
  .chip { display: inline-block; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 8px; padding: 0 8px; font-size: 11px; cursor: pointer; }
  td.detail { padding: 6px 10px 10px 24px; background: var(--vscode-editorWidget-background, transparent); white-space: normal; max-width: none; }
  .nothing { color: var(--vscode-descriptionForeground); padding: 24px 12px; }
</style>
</head>
<body>
  <div class="toolbar">
    <h1 id="title"></h1>
    <span class="meta" id="meta"></span>
    <button id="filterToggle">Filters &amp; paging</button>
    <button id="prevPage">‹ Prev</button>
    <button id="nextPage">Next ›</button>
    <button id="openJson">Open as JSON</button>
    <span class="meta" id="ver" title="navapi-vscode version"></span>
  </div>

  <div id="filterPanel">
    <div id="frows"></div>
    <div class="factions">
      <button id="addRow">+ Add filter</button>
      <span class="spacer"></span>
      <label>Page <input id="pageStart" class="pg" type="number" min="1"></label>
      <label>Page size <input id="pageSize" class="pg" type="number" min="1"></label>
      <button id="apply" class="primary">Apply</button>
      <button id="clearFilters">Clear</button>
    </div>
    <div class="hint">Filters use BC filter syntax (e.g. 10000..20000, &lt;&gt;'', *foo*). Table/field accept names or numbers.</div>
  </div>

  <div id="error"></div>
  <div class="wrap" id="root"></div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const state = ${embedJson(state)};
  const filters = state.filters.length ? state.filters.map((f) => ({ ...f })) : [];

  function el(id) { return document.getElementById(id); }

  // ------------------------------------------------------------- toolbar
  el('title').textContent = state.title;
  const metaParts = [state.endpointType, state.outputJsonType].filter(Boolean);
  metaParts.push(
    state.topLevelRecordCount !== undefined
      ? state.recordCount + ' rows (page ' + state.pageStart + ', ' + state.topLevelRecordCount + ' top-level total)'
      : state.recordCount + ' rows',
  );
  el('meta').textContent = metaParts.join(' · ');
  el('ver').textContent = 'v' + state.version;
  el('error').textContent = state.error || '';
  el('prevPage').disabled = state.pageStart <= 1;
  el('nextPage').disabled = !state.hasMore;

  function post(pageStart) {
    vscode.postMessage({
      type: 'load',
      filters: filters.filter((f) => f.table !== '' && f.field !== '' && f.filter !== ''),
      pageStart,
      pageSize: Number(el('pageSize').value) || undefined,
    });
  }

  el('prevPage').addEventListener('click', () => post(state.pageStart - 1));
  el('nextPage').addEventListener('click', () => post(state.pageStart + 1));
  el('apply').addEventListener('click', () => post(Number(el('pageStart').value) || 1));
  el('openJson').addEventListener('click', () => vscode.postMessage({ type: 'openJson' }));
  el('filterToggle').addEventListener('click', () => el('filterPanel').classList.toggle('open'));
  el('clearFilters').addEventListener('click', () => {
    filters.length = 0;
    renderFilterRows();
    post(1);
  });

  // ------------------------------------------------------- filter editor
  el('pageStart').value = String(state.pageStart);
  if (state.pageSize) el('pageSize').value = String(state.pageSize);

  function renderFilterRows() {
    const host = el('frows');
    host.replaceChildren();
    filters.forEach((row, idx) => {
      const div = document.createElement('div');
      div.className = 'frow';
      const tbl = document.createElement('input');
      tbl.className = 'tbl';
      tbl.placeholder = 'Table (name or no.)';
      tbl.value = String(row.table ?? '');
      tbl.addEventListener('input', () => { row.table = tbl.value; });
      const fld = document.createElement('input');
      fld.className = 'fld';
      fld.placeholder = 'Field (name or no.)';
      fld.value = String(row.field ?? '');
      fld.addEventListener('input', () => { row.field = fld.value; });
      const flt = document.createElement('input');
      flt.className = 'flt';
      flt.placeholder = "BC filter, e.g. 10000..20000";
      flt.value = String(row.filter ?? '');
      flt.addEventListener('input', () => { row.filter = flt.value; });
      const del = document.createElement('button');
      del.className = 'del';
      del.textContent = '✕';
      del.addEventListener('click', () => { filters.splice(idx, 1); renderFilterRows(); });
      div.append(tbl, fld, flt, del);
      host.appendChild(div);
    });
  }
  el('addRow').addEventListener('click', () => {
    filters.push({ table: '', field: '', filter: '' });
    el('filterPanel').classList.add('open');
    renderFilterRows();
  });
  renderFilterRows();
  if (filters.length) el('filterPanel').classList.add('open');

  // --------------------------------------------------------------- grid
  // Record data is rendered DOM-only (textContent), never as HTML.
  function renderTable(grid) {
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const col of grid.columns) {
      const th = document.createElement('th');
      th.textContent = col;
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    const tbody = document.createElement('tbody');
    grid.rows.forEach((cells) => {
      const tr = document.createElement('tr');
      cells.forEach((cell) => {
        const td = document.createElement('td');
        if (cell.nested) {
          const chip = document.createElement('span');
          chip.className = 'chip';
          chip.textContent = cell.text;
          chip.addEventListener('click', () => toggleNested(tr, cell, grid.columns.length));
          td.appendChild(chip);
        } else {
          td.textContent = cell.text;
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.append(thead, tbody);
    return table;
  }

  function toggleNested(tr, cell, colCount) {
    const next = tr.nextElementSibling;
    if (next && next.classList.contains('nestedrow')) {
      next.remove();
      return;
    }
    const row = document.createElement('tr');
    row.className = 'nestedrow';
    const td = document.createElement('td');
    td.className = 'detail';
    td.colSpan = colCount;
    td.appendChild(renderTable(cell.nested));
    row.appendChild(td);
    tr.after(row);
  }

  const root = el('root');
  if (!state.grid.rows.length) {
    const div = document.createElement('div');
    div.className = 'nothing';
    div.textContent = state.error ? 'Request failed.' : 'No records.';
    root.appendChild(div);
  } else {
    root.appendChild(renderTable(state.grid));
  }
</script>
</body>
</html>`;
}
