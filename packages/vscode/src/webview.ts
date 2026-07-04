/**
 * HTML for the records grid webview. Record data is embedded as JSON and
 * rendered exclusively via DOM APIs (createElement/textContent), so record
 * content can never inject markup. Strict CSP: nonce'd script, inline style.
 *
 * Layout is a flex column (toolbar / filter panel / scrolling table wrap),
 * so the sticky header pins to the top of its own scroll container — no
 * hardcoded offsets to drift out of sync with the toolbar height.
 */
import type { FilterField } from './filter.js';
import type { GridData } from './grid.js';

export interface RecordsViewState {
  title: string;
  grid: GridData;
  /** Records fetched so far. */
  count: number;
  /** Total matching records from $count (the Y in "x of Y"). */
  totalCount?: number;
  hasMore: boolean;
  /** Filterable fields (schema properties) with their valid operators. */
  fields: FilterField[];
  /** Navigation property names — one FastTab each in the detail pane. */
  navProps: string[];
  /** The currently applied $filter, '' when none. */
  filter: string;
  /** The currently applied $select fields, [] when all. */
  select: string[];
  /** Server-side $orderby currently applied, null when none. */
  orderby: { field: string; dir: 'asc' | 'desc' } | null;
  /** The full request URI of the current query — for copy/paste sharing. */
  queryUrl: string;
  /** Extension version — visible so stale installs are diagnosable. */
  version: string;
}

export function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

/** JSON safe to embed inside a <script> element. */
function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028')
    .replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029');
}

export function renderRecordsHtml(state: RecordsViewState, nonce: string): string {
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
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: .5; cursor: default; }
  button.active { outline: 1px solid var(--vscode-focusBorder); }

  #filterPanel { flex: 0 0 auto; display: none; padding: 4px 12px 10px; border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,.25)); }
  #filterPanel.open { display: block; }
  .frow { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; }
  select, .frow input, #expr { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 3px 6px; border-radius: 2px; font-size: 12px; }
  .frow select.field { width: 180px; }
  .frow select.op { width: 110px; }
  .frow input.val, .frow select.val { flex: 1; }
  .frow .del { padding: 3px 8px; }
  .factions { display: flex; gap: 8px; align-items: center; margin-top: 6px; }
  .factions .spacer { margin-left: auto; }
  .factions label { font-size: 12px; color: var(--vscode-descriptionForeground); }
  #expr { width: 100%; box-sizing: border-box; font-family: var(--vscode-editor-font-family, monospace); margin-top: 6px; }
  .plabel { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 8px; display: block; }
  #filterError { color: var(--vscode-errorForeground); font-size: 12px; margin-top: 6px; min-height: 14px; white-space: pre-wrap; }
  #fieldPicks { display: flex; flex-wrap: wrap; gap: 2px 12px; max-height: 110px; overflow-y: auto; margin-top: 4px; padding: 4px 6px; border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,.2)); border-radius: 2px; }
  #fieldPicks label { font-size: 12px; display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
  .urlrow { display: flex; gap: 6px; margin-top: 6px; }
  #queryUrl { flex: 1; box-sizing: border-box; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; background: var(--vscode-input-background); color: var(--vscode-descriptionForeground); border: 1px solid var(--vscode-input-border, transparent); padding: 3px 6px; border-radius: 2px; }

  .wrap { flex: 1 1 auto; overflow: auto; padding: 0 12px 12px; }
  table { border-collapse: collapse; font-size: 12px; width: max-content; min-width: 100%; }
  th, td { text-align: left; padding: 4px 10px; border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,.2)); white-space: nowrap; max-width: 340px; overflow: hidden; text-overflow: ellipsis; }
  th { position: sticky; top: 0; z-index: 1; background: var(--vscode-editor-background); cursor: pointer; user-select: none; font-weight: 600; color: var(--vscode-descriptionForeground); box-shadow: 0 1px 0 var(--vscode-editorWidget-border, rgba(128,128,128,.25)); }
  th .dir { opacity: .7; }
  tbody tr:hover { background: var(--vscode-list-hoverBackground); }
  tbody tr.sel, tbody tr.sel:hover { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .chip { display: inline-block; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 8px; padding: 0 8px; font-size: 11px; cursor: pointer; }
  td.detail { padding: 6px 10px 10px 24px; background: var(--vscode-editorWidget-background, transparent); white-space: normal; max-width: none; }
  .nothing { color: var(--vscode-descriptionForeground); padding: 24px 12px; }

  #detailPane { flex: 0 0 auto; max-height: 45%; overflow-y: auto; border-top: 2px solid var(--vscode-focusBorder, rgba(128,128,128,.4)); display: none; }
  #detailPane.open { display: block; }
  .dhead { display: flex; align-items: center; gap: 8px; padding: 8px 12px 4px; font-weight: 600; font-size: 13px; position: sticky; top: 0; background: var(--vscode-editor-background); z-index: 2; }
  .dhead .dclose { margin-left: auto; }
  .ftab { border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,.2)); }
  .fhead { display: flex; align-items: center; gap: 6px; padding: 6px 12px; cursor: pointer; font-weight: 600; font-size: 12px; user-select: none; }
  .fhead:hover { background: var(--vscode-list-hoverBackground); }
  .fhead .fcount { color: var(--vscode-descriptionForeground); font-weight: 400; }
  .fbody { display: none; padding: 2px 12px 10px 28px; overflow-x: auto; }
  .ftab.open > .fbody { display: block; }
  .floading, .ferror { font-size: 12px; color: var(--vscode-descriptionForeground); }
  .ferror { color: var(--vscode-errorForeground); white-space: pre-wrap; }

  #ctxMenu { position: fixed; z-index: 10; display: none; min-width: 180px; background: var(--vscode-menu-background, var(--vscode-editorWidget-background, var(--vscode-editor-background))); color: var(--vscode-menu-foreground, var(--vscode-foreground)); border: 1px solid var(--vscode-menu-border, rgba(128,128,128,.35)); box-shadow: 0 2px 8px rgba(0,0,0,.35); padding: 4px 0; border-radius: 4px; }
  #ctxMenu.open { display: block; }
  #ctxMenu .mi { padding: 4px 14px; cursor: pointer; font-size: 12.5px; white-space: nowrap; }
  #ctxMenu .mi:hover { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-menu-selectionForeground, inherit); }
  #ctxMenu .mi.disabled { opacity: .45; cursor: default; }
  #ctxMenu .mi.disabled:hover { background: none; color: inherit; }
</style>
</head>
<body>
  <div class="toolbar">
    <h1 id="title"></h1>
    <span class="meta" id="meta"></span>
    <button id="filterToggle">Query</button>
    <button id="loadMore" style="display:none">Load more</button>
    <button id="openJson">Open as JSON</button>
    <span class="meta" id="ver" title="navapi-vscode version"></span>
  </div>

  <div id="filterPanel">
    <div id="frows"></div>
    <div class="factions">
      <button id="addRow">+ Add condition</button>
      <label>Match
        <select id="combinator">
          <option value="and">all (and)</option>
          <option value="or">any (or)</option>
        </select>
      </label>
      <span class="spacer"></span>
      <button id="applyFilter" class="primary">Apply</button>
      <button id="clearFilter">Clear</button>
    </div>
    <label class="plabel" for="expr">OData $filter (generated — edit to take over)</label>
    <input id="expr" spellcheck="false">
    <label class="plabel">Fields ($select) — none checked = all fields</label>
    <div id="fieldPicks"></div>
    <label class="plabel" for="queryUrl">Query URL</label>
    <div class="urlrow">
      <input id="queryUrl" readonly spellcheck="false">
      <button id="copyUrl" title="Copy the full request URL">Copy</button>
    </div>
    <div id="filterError"></div>
  </div>

  <div class="wrap" id="root"></div>

  <div id="detailPane">
    <div class="dhead">
      <span id="dtitle"></span>
      <button class="dclose" id="dclose" title="Close (Esc)">✕</button>
    </div>
    <div id="dtabs"></div>
  </div>

  <div id="ctxMenu"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let state = ${embedJson(state)};
    let sortCol = -1, sortDir = 1;
    let rows = [];
    let manualExpr = false;
    let previewTimer;
    let selected = new Set(state.select);

    const el = (id) => document.getElementById(id);

    function renderFieldPicks() {
      const host = el('fieldPicks');
      host.replaceChildren();
      for (const f of state.fields) {
        const label = document.createElement('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = selected.has(f.name);
        cb.addEventListener('change', () => {
          if (cb.checked) selected.add(f.name); else selected.delete(f.name);
        });
        label.append(cb, document.createTextNode(f.name));
        label.title = f.type;
        host.appendChild(label);
      }
    }

    // ---------------------------------------------------------- filter panel
    function fieldByName(name) {
      return state.fields.find((f) => f.name === name) || state.fields[0];
    }

    function requestPreview() {
      if (manualExpr) return;
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => {
        vscode.postMessage({ type: 'previewFilter', rows, combinator: el('combinator').value });
      }, 120);
    }

    function renderFilterRows() {
      const host = el('frows');
      host.replaceChildren();
      rows.forEach((row, idx) => {
        const div = document.createElement('div');
        div.className = 'frow';

        const fieldSel = document.createElement('select');
        fieldSel.className = 'field';
        for (const f of state.fields) {
          const opt = document.createElement('option');
          opt.value = f.name;
          opt.textContent = f.name;
          if (f.name === row.field) opt.selected = true;
          fieldSel.appendChild(opt);
        }
        fieldSel.addEventListener('change', () => {
          const f = fieldByName(fieldSel.value);
          row.field = f.name; row.type = f.type; row.op = f.ops[0]; row.value = '';
          renderFilterRows(); requestPreview();
        });

        const opSel = document.createElement('select');
        opSel.className = 'op';
        for (const op of fieldByName(row.field).ops) {
          const opt = document.createElement('option');
          opt.value = op;
          opt.textContent = op;
          if (op === row.op) opt.selected = true;
          opSel.appendChild(opt);
        }
        opSel.addEventListener('change', () => { row.op = opSel.value; requestPreview(); });

        let valInput;
        if (row.type === 'Edm.Boolean') {
          valInput = document.createElement('select');
          valInput.className = 'val';
          row.value = row.value || 'true';
          for (const v of ['true', 'false']) {
            const opt = document.createElement('option');
            opt.value = v; opt.textContent = v;
            if (v === row.value) opt.selected = true;
            valInput.appendChild(opt);
          }
        } else {
          valInput = document.createElement('input');
          valInput.className = 'val';
          valInput.value = row.value;
          valInput.placeholder = row.type.replace('Edm.', '');
        }
        valInput.addEventListener('input', () => { row.value = valInput.value; requestPreview(); });
        valInput.addEventListener('change', () => { row.value = valInput.value; requestPreview(); });

        const del = document.createElement('button');
        del.className = 'del';
        del.textContent = '×';
        del.title = 'Remove condition';
        del.addEventListener('click', () => { rows.splice(idx, 1); renderFilterRows(); requestPreview(); });

        div.append(fieldSel, opSel, valInput, del);
        host.appendChild(div);
      });
    }

    el('addRow').addEventListener('click', () => {
      const f = state.fields[0];
      if (!f) return;
      rows.push({ field: f.name, type: f.type, op: f.ops[0], value: '' });
      manualExpr = false;
      renderFilterRows();
      requestPreview();
    });
    el('combinator').addEventListener('change', requestPreview);
    el('expr').addEventListener('input', () => { manualExpr = true; });
    el('filterToggle').addEventListener('click', () => {
      el('filterPanel').classList.toggle('open');
      if (el('filterPanel').classList.contains('open') && !rows.length && !el('expr').value) {
        el('addRow').click();
      }
    });
    el('applyFilter').addEventListener('click', () => {
      el('applyFilter').disabled = true;
      el('filterError').textContent = '';
      vscode.postMessage({
        type: 'applyQuery',
        rows,
        combinator: el('combinator').value,
        manual: manualExpr ? el('expr').value : undefined,
        select: [...selected],
      });
    });
    el('clearFilter').addEventListener('click', () => {
      rows = [];
      manualExpr = false;
      selected = new Set();
      el('expr').value = '';
      el('filterError').textContent = '';
      renderFilterRows();
      renderFieldPicks();
      vscode.postMessage({ type: 'applyQuery', rows: [], combinator: 'and', select: [] });
    });
    el('copyUrl').addEventListener('click', () => vscode.postMessage({ type: 'copyUrl' }));

    // --------------------------------------------- cell context menu (BC-style)
    function hideCtxMenu() { el('ctxMenu').classList.remove('open'); }
    document.addEventListener('click', hideCtxMenu);

    function showCtxMenu(x, y, items) {
      const menu = el('ctxMenu');
      menu.replaceChildren();
      for (const it of items) {
        const mi = document.createElement('div');
        mi.className = 'mi' + (it.enabled === false ? ' disabled' : '');
        mi.textContent = it.label;
        if (it.enabled !== false) {
          mi.addEventListener('click', (e) => { e.stopPropagation(); hideCtxMenu(); it.action(); });
        }
        menu.appendChild(mi);
      }
      menu.classList.add('open');
      const rect = menu.getBoundingClientRect();
      menu.style.left = Math.max(0, Math.min(x, window.innerWidth - rect.width - 4)) + 'px';
      menu.style.top = Math.max(0, Math.min(y, window.innerHeight - rect.height - 4)) + 'px';
    }

    /** Adds a builder row for a field; with applyNow also requeries at once. */
    function addFilterRowFor(fieldName, value, applyNow) {
      const f = state.fields.find((x) => x.name === fieldName);
      if (!f) return;
      el('filterPanel').classList.add('open');
      manualExpr = false;
      const op = applyNow && f.ops.includes('eq') ? 'eq' : f.ops[0];
      rows.push({
        field: f.name,
        type: f.type,
        op,
        value: value !== undefined ? value : f.type === 'Edm.Boolean' ? 'true' : '',
      });
      renderFilterRows();
      requestPreview();
      if (applyNow) {
        el('applyFilter').disabled = true;
        el('filterError').textContent = '';
        vscode.postMessage({
          type: 'applyQuery',
          rows,
          combinator: el('combinator').value,
          select: [...selected],
        });
      } else {
        const inputs = el('frows').querySelectorAll('.val');
        const last = inputs[inputs.length - 1];
        if (last) last.focus();
      }
    }

    // ------------------------------------------------------------- toolbar
    el('openJson').addEventListener('click', () => vscode.postMessage({ type: 'openJson' }));
    el('loadMore').addEventListener('click', () => {
      el('loadMore').disabled = true;
      vscode.postMessage({ type: 'loadMore' });
    });

    window.addEventListener('message', (e) => {
      const msg = e.data || {};
      if (msg.type === 'state') {
        state = msg.state;
        selectedRow = -1; // records changed; old selection no longer valid
        navCache = {};
        openTabs = new Set(['General']);
        renderFieldPicks();
        render();
        renderDetail();
      }
      if (msg.type === 'filterPreview' && !manualExpr) { el('expr').value = msg.text; }
      if (msg.type === 'filterError') {
        el('applyFilter').disabled = false;
        el('filterError').textContent = msg.message;
      }
      if (msg.type === 'navResult' || msg.type === 'navError') {
        navCache[msg.rowIndex] = navCache[msg.rowIndex] || {};
        navCache[msg.rowIndex][msg.nav] = msg.type === 'navResult'
          ? { kind: msg.kind, count: msg.count, grid: msg.grid }
          : { error: msg.message };
        if (msg.rowIndex === selectedRow) renderDetail();
      }
    });

    // ------------------------------------------------------- detail pane
    let selectedRow = -1;
    let navCache = {};
    let openTabs = new Set(['General']);

    function selectRow(idx) {
      selectedRow = selectedRow === idx ? -1 : idx;
      openTabs = new Set(['General']);
      render();
      renderDetail();
    }

    el('dclose').addEventListener('click', () => { selectedRow = -1; render(); renderDetail(); });
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (el('ctxMenu').classList.contains('open')) { hideCtxMenu(); return; }
      if (selectedRow >= 0) { selectedRow = -1; render(); renderDetail(); }
    });

    function makeTab(label, nav) {
      const tab = document.createElement('div');
      tab.className = 'ftab';
      const head = document.createElement('div');
      head.className = 'fhead';
      const caret = document.createElement('span');
      const name = document.createElement('span');
      name.textContent = label;
      const count = document.createElement('span');
      count.className = 'fcount';
      const body = document.createElement('div');
      body.className = 'fbody';

      const cached = nav ? (navCache[selectedRow] || {})[nav] : undefined;
      if (nav && cached && cached.kind === 'collection') {
        count.textContent = '(' + cached.count + ')';
      }

      const fill = () => {
        body.replaceChildren();
        if (!nav) {
          const cells = state.grid.rows[selectedRow] || [];
          const g = {
            columns: ['field', 'value'],
            rows: state.grid.columns.map((c, i) => [
              { kind: 'text', text: c },
              cells[i] || { kind: 'empty', text: '' },
            ]),
          };
          body.appendChild(buildTable(g, false));
          return;
        }
        const entry = (navCache[selectedRow] || {})[nav];
        if (!entry) {
          const div = document.createElement('div');
          div.className = 'floading';
          div.textContent = 'Loading…';
          body.appendChild(div);
          vscode.postMessage({ type: 'fetchNav', rowIndex: selectedRow, nav });
          return;
        }
        if (entry.error) {
          const div = document.createElement('div');
          div.className = 'ferror';
          div.textContent = entry.error;
          body.appendChild(div);
          return;
        }
        if (!entry.grid.rows.length) {
          const div = document.createElement('div');
          div.className = 'floading';
          div.textContent = '(empty)';
          body.appendChild(div);
          return;
        }
        body.appendChild(buildTable(entry.grid, false));
      };

      const open = openTabs.has(label);
      caret.textContent = open ? '▾' : '▸';
      if (open) { tab.classList.add('open'); fill(); }
      head.addEventListener('click', () => {
        if (openTabs.has(label)) { openTabs.delete(label); } else { openTabs.add(label); }
        renderDetail();
      });

      head.append(caret, name, count);
      tab.append(head, body);
      return tab;
    }

    function renderDetail() {
      const pane = el('detailPane');
      if (selectedRow < 0 || selectedRow >= state.grid.rows.length) {
        pane.classList.remove('open');
        return;
      }
      pane.classList.add('open');
      const cells = state.grid.rows[selectedRow];
      const identity = cells
        .slice(0, 3)
        .map((c) => c.text)
        .filter(Boolean)
        .slice(0, 2)
        .join('  ·  ');
      el('dtitle').textContent = identity || 'record ' + (selectedRow + 1);
      const tabs = el('dtabs');
      tabs.replaceChildren();
      tabs.appendChild(makeTab('General', null));
      for (const nav of state.navProps) tabs.appendChild(makeTab(nav, nav));
    }

    // ----------------------------------------------------------------- grid
    function cellNode(cell, tag) {
      const node = document.createElement(tag);
      if (cell.kind === 'empty') { node.textContent = ''; }
      else if (cell.nested) {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = cell.kind === 'object' ? '{…}' : cell.text;
        chip.title = 'Click to expand';
        node.appendChild(chip);
      } else {
        node.textContent = cell.text;
        node.title = cell.text;
      }
      return node;
    }

    function buildTable(grid, interactive) {
      const table = document.createElement('table');
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      grid.columns.forEach((col, i) => {
        const th = document.createElement('th');
        th.textContent = col;
        if (interactive) {
          const serverSorted = state.orderby && state.orderby.field === col;
          if (serverSorted) {
            const dir = document.createElement('span');
            dir.className = 'dir';
            dir.textContent = state.orderby.dir === 'asc' ? ' ▲' : ' ▼';
            th.appendChild(dir);
            th.title = 'Sorted server-side ($orderby)';
          } else if (!state.orderby && i === sortCol) {
            const dir = document.createElement('span');
            dir.className = 'dir';
            dir.textContent = sortDir > 0 ? ' ▲' : ' ▼';
            th.appendChild(dir);
          }
          th.addEventListener('click', () => {
            const isProperty = state.fields.some((f) => f.name === col);
            // Partial datasets (or an active server sort) must sort at the
            // server, or the "top" rows would be a lie. Local sort only when
            // everything is loaded, or for non-property (expanded) columns.
            if (isProperty && (state.hasMore || state.orderby)) {
              const dir = serverSorted && state.orderby.dir === 'asc' ? 'desc' : 'asc';
              vscode.postMessage({ type: 'sortBy', field: col, dir });
              return;
            }
            if (sortCol === i) { sortDir = -sortDir; } else { sortCol = i; sortDir = 1; }
            render();
          });
        }
        headRow.appendChild(th);
      });
      thead.appendChild(headRow);
      table.appendChild(thead);

      const tbody = document.createElement('tbody');
      const dataRows = grid.rows.map((cells, idx) => ({ cells, idx }));
      if (interactive && sortCol >= 0) {
        dataRows.sort((a, b) => {
          const av = a.cells[sortCol] ? a.cells[sortCol].text : '';
          const bv = b.cells[sortCol] ? b.cells[sortCol].text : '';
          const an = parseFloat(av), bn = parseFloat(bv);
          const cmp = !Number.isNaN(an) && !Number.isNaN(bn) && String(an) === av.trim() && String(bn) === bv.trim()
            ? an - bn
            : av.localeCompare(bv);
          return cmp * sortDir;
        });
      }
      for (const row of dataRows) {
        const tr = document.createElement('tr');
        if (interactive) {
          if (row.idx === selectedRow) tr.classList.add('sel');
          tr.addEventListener('click', (e) => {
            if (e.target.closest && e.target.closest('.chip')) return;
            selectRow(row.idx);
          });
        }
        row.cells.forEach((cell, ci) => {
          const td = cellNode(cell, 'td');
          if (interactive) {
            td.addEventListener('contextmenu', (e) => {
              const colName = grid.columns[ci];
              if (!state.fields.some((f) => f.name === colName)) return; // native menu
              e.preventDefault();
              showCtxMenu(e.clientX, e.clientY, [
                { label: 'Filter…', action: () => addFilterRowFor(colName, undefined, false) },
                {
                  label: 'Filter to This Value',
                  enabled: cell.kind === 'text',
                  action: () => addFilterRowFor(colName, cell.text, true),
                },
                {
                  label: 'Copy Value',
                  enabled: cell.kind === 'text',
                  action: () => vscode.postMessage({ type: 'copyValue', text: cell.text }),
                },
              ]);
            });
          }
          const chip = td.querySelector('.chip');
          if (chip) {
            chip.addEventListener('click', () => {
              const existing = tr.nextElementSibling;
              if (existing && existing.dataset.detailFor === String(row.idx)) { existing.remove(); return; }
              if (existing && existing.dataset.detailFor !== undefined) existing.remove();
              const detailTr = document.createElement('tr');
              detailTr.dataset.detailFor = String(row.idx);
              const detailTd = document.createElement('td');
              detailTd.className = 'detail';
              detailTd.colSpan = grid.columns.length;
              detailTd.appendChild(buildTable(cell.nested, false));
              detailTr.appendChild(detailTd);
              tr.after(detailTr);
            });
          }
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      return table;
    }

    function render() {
      el('title').textContent = state.title;
      const total = typeof state.totalCount === 'number' ? state.totalCount : undefined;
      const counts = total !== undefined && total !== state.count
        ? state.count + ' of ' + total.toLocaleString()
        : String(state.count);
      el('meta').textContent =
        counts + ' record' + ((total ?? state.count) === 1 ? '' : 's') +
        (state.filter ? ' (filtered)' : '') +
        (state.select.length ? ' · ' + state.select.length + ' fields' : '');
      el('filterToggle').classList.toggle('active', Boolean(state.filter || state.select.length));
      el('ver').textContent = 'v' + state.version;
      el('queryUrl').value = state.queryUrl;
      el('queryUrl').title = state.queryUrl;
      const loadMore = el('loadMore');
      loadMore.style.display = state.hasMore ? '' : 'none';
      loadMore.disabled = false;
      el('applyFilter').disabled = false;
      const root = el('root');
      root.replaceChildren();
      if (!state.grid.rows.length) {
        const div = document.createElement('div');
        div.className = 'nothing';
        div.textContent = state.filter ? 'No records match the filter.' : 'No records.';
        root.appendChild(div);
        return;
      }
      root.appendChild(buildTable(state.grid, true));
    }
    renderFieldPicks();
    render();
  </script>
</body>
</html>`;
}
