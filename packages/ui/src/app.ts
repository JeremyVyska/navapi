function escapeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028')
    .replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029');
}

export function renderAppHtml(nonce: string, version: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'self'; font-src 'self'; img-src 'self' data:; style-src 'self' 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'">
  <title>navapi</title>
  <link rel="stylesheet" href="/assets/codicon.css">
  <style nonce="${nonce}">
    :root { color-scheme:light; --bg:#fff; --panel:#f6f8fa; --section:#eaeef2; --panel2:#dbe5f1; --line:#d0d7de; --text:#1f2328; --muted:#656d76; --accent:#0969da; --on-accent:#fff; --danger:#cf222e; --ok:#1a7f37; --entity:#9a6700; --backdrop:rgba(31,35,40,.4); }
    @media (prefers-color-scheme: dark) {
      :root { color-scheme:dark; --bg:#0d1117; --panel:#161b22; --section:#1b2028; --panel2:#21262d; --line:#30363d; --text:#e6edf3; --muted:#8b949e; --accent:#2f81f7; --on-accent:#fff; --danger:#ff7b72; --ok:#3fb950; --entity:#ee9d28; --backdrop:rgba(0,0,0,.65); }
    }
    * { box-sizing:border-box; } html,body { height:100%; margin:0; }
    body { font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif; background:var(--bg); color:var(--text); overflow:hidden; }
    button,input,select { font:inherit; } button { border:1px solid var(--line); background:var(--panel2); color:var(--text); border-radius:6px; padding:6px 10px; cursor:pointer; }
    button:hover { border-color:var(--muted); } button.primary { background:var(--accent); border-color:var(--accent); color:var(--on-accent); } button.danger { color:var(--danger); }
    button:disabled { opacity:.55; cursor:default; } input,select { background:var(--bg); color:var(--text); border:1px solid var(--line); border-radius:6px; padding:7px 9px; min-width:0; }
    #shell { display:grid; grid-template-columns:300px 1fr; height:100%; }
    aside { border-right:1px solid var(--line); background:var(--panel); display:flex; flex-direction:column; min-width:0; }
    header { height:54px; display:flex; align-items:center; gap:9px; padding:0 14px; border-bottom:1px solid var(--line); }
    .brand { font-size:17px; font-weight:700; letter-spacing:.2px; } .brand span { color:var(--accent); }
    .version { color:var(--muted); font-size:11px; margin-left:auto; }
    .side-scroll { flex:1 1 0; min-height:0; overflow:hidden; display:flex; flex-direction:column; }
    .section { flex:0 1 auto; min-height:38px; max-height:30%; display:flex; flex-direction:column; border-bottom:2px solid var(--line); }
    .section.endpoint-section { flex:1 1 0; max-height:none; }
    .section.collapsed { flex:0 0 38px; }
    .section.context-section.collapsed { flex-basis:54px; }
    .section-head { flex:0 0 38px; display:flex; align-items:center; gap:6px; padding:5px 12px; background:var(--section); text-transform:uppercase; letter-spacing:.08em; font-size:11px; color:var(--muted); font-weight:700; }
    .section-head.has-context { flex-basis:54px; }
    .section-head > button:not(.section-toggle) { padding:2px 7px; }
    .section-toggle { min-width:0; display:flex; align-items:center; gap:8px; border:0; background:transparent; padding:3px 0; color:var(--text); font-weight:inherit; text-transform:inherit; letter-spacing:inherit; }
    .section-toggle:hover { color:var(--text); border-color:transparent; }
    .section-heading { min-width:0; flex:1; overflow:hidden; }
    .section-heading .section-toggle { width:100%; white-space:nowrap; }
    .section-context { display:block; min-width:0; padding-left:15px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-transform:none; letter-spacing:normal; font-weight:400; }
    .section-toggle .chevron { transform:rotate(45deg); }
    .section-toggle[aria-expanded="false"] .chevron { transform:rotate(-45deg); }
    .section-body { min-height:0; overflow:auto; padding:0 12px 10px; }
    .item { display:block; width:100%; border:0; background:transparent; text-align:left; padding:7px 8px; border-radius:5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .item:hover,.item.active { background:var(--panel2); } .item small { display:block; color:var(--muted); overflow:hidden; text-overflow:ellipsis; }
    .route-toggle,.entity { display:flex; align-items:center; gap:7px; }
    .route-toggle { margin-top:2px; font-weight:600; }
    .route-toggle .label,.entity .label { min-width:0; overflow:hidden; text-overflow:ellipsis; }
    .route-count { margin-left:auto; color:var(--muted); font-size:11px; font-weight:400; }
    .chevron { width:7px; height:7px; flex:0 0 auto; border-right:1.5px solid currentColor; border-bottom:1.5px solid currentColor; transform:rotate(-45deg); transition:transform .12s ease; }
    .route-toggle[aria-expanded="true"] .chevron { transform:rotate(45deg); }
    .tree-icon { width:16px; height:16px; flex:0 0 auto; }
    .route-toggle .tree-icon { color:var(--text); }
    .entity { padding-left:31px; } .entity .tree-icon { color:var(--entity); }
    .route-children[hidden] { display:none; }
    main { min-width:0; display:flex; flex-direction:column; } #mainHead { flex:0 0 auto; } #content { flex:1; min-height:0; overflow:auto; padding:16px; }
    #title { font-size:14px; font-weight:650; } #status { color:var(--muted); margin-left:auto; max-width:40%; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .hero { max-width:720px; margin:12vh auto; text-align:center; color:var(--muted); } .hero h1 { color:var(--text); font-size:28px; }
    .toolbar { display:flex; flex-wrap:wrap; gap:7px; align-items:center; margin-bottom:12px; } .toolbar .grow { flex:1; }
    .query { display:none; border:1px solid var(--line); border-radius:7px; padding:10px; margin-bottom:12px; background:var(--panel); }
    .query.open { display:block; }
    .query-row { display:grid; grid-template-columns:190px 130px minmax(180px,1fr) auto; gap:7px; margin:6px 0; }
    .query-label { display:block; margin-top:9px; color:var(--muted); font-size:11px; }
    .query-input { width:100%; margin-top:4px; font-family:ui-monospace,SFMono-Regular,Consolas,monospace; }
    .url-row { display:flex; gap:7px; margin-top:4px; } .url-row input { flex:1; }
    .field-picks { display:flex; flex-wrap:wrap; gap:5px 12px; max-height:110px; overflow:auto; margin-top:4px; padding:7px; border:1px solid var(--line); border-radius:6px; color:var(--muted); } .field-picks label { white-space:nowrap; }
    .table-wrap { overflow:auto; border:1px solid var(--line); border-radius:7px; } table { border-collapse:collapse; min-width:100%; width:max-content; }
    th,td { padding:7px 10px; border-bottom:1px solid var(--line); text-align:left; white-space:nowrap; max-width:360px; overflow:hidden; text-overflow:ellipsis; }
    th { position:sticky; top:0; background:var(--panel); color:var(--muted); cursor:pointer; z-index:1; } th.nonsort { cursor:default; } tr:hover td { background:var(--panel); }
    .chip { border-radius:10px; background:var(--panel2); padding:1px 8px; } .empty { color:var(--muted); padding:25px; text-align:center; }
    .meta { color:var(--muted); } .error { color:var(--danger); white-space:pre-wrap; } .ok { color:var(--ok); } .hidden { display:none; } .grow { flex:1; }
    dialog { width:min(700px,calc(100vw - 32px)); max-height:calc(100vh - 40px); overflow:auto; border:1px solid var(--line); border-radius:9px; background:var(--panel); color:var(--text); padding:0; }
    dialog::backdrop { background:var(--backdrop); } .dialog-head { display:flex; align-items:center; padding:13px 16px; border-bottom:1px solid var(--line); } .dialog-head h2 { font-size:15px; margin:0; }
    .dialog-body { padding:15px 16px; } .dialog-actions { display:flex; gap:8px; justify-content:flex-end; padding:12px 16px; border-top:1px solid var(--line); }
    .form-grid { display:grid; grid-template-columns:145px 1fr; gap:10px; align-items:center; } .form-grid label { color:var(--muted); } .form-grid input { width:100%; }
    pre { background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:12px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; }
    #detailFields { display:grid; grid-template-columns:max-content 1fr; gap:5px 15px; } #detailFields b { color:var(--muted); font-weight:500; }
    .nav-result { margin-top:12px; } .nav-result h3 { font-size:13px; }
    @media (max-width:760px) { #shell { grid-template-columns:220px 1fr; } .query-row { grid-template-columns:1fr 110px; } .query-row input { grid-column:1 / -1; } }
  </style>
</head>
<body>
<div id="shell">
  <aside>
    <header><div class="brand"><span>nav</span>api</div><div class="version">v${version}</div></header>
    <div class="side-scroll">
      <section class="section"><div class="section-head"><button class="section-toggle" type="button" aria-expanded="true" aria-controls="profiles"><span class="chevron"></span><span>Profiles</span></button><span class="grow"></span><button id="editProfile">Edit</button><button id="addProfile">+</button></div><div id="profiles" class="section-body"></div></section>
      <section class="section context-section"><div class="section-head has-context"><div class="section-heading"><button class="section-toggle" type="button" aria-expanded="true" aria-controls="companies"><span class="chevron"></span><span>Companies</span></button><span id="companiesProfile" class="section-context"></span></div><button id="refreshCompanies">↻</button></div><div id="companies" class="section-body"></div></section>
      <section class="section context-section endpoint-section"><div class="section-head has-context"><div class="section-heading"><button class="section-toggle" type="button" aria-expanded="true" aria-controls="endpoints"><span class="chevron"></span><span>Endpoint Browser</span></button><span id="endpointsProfile" class="section-context"></span></div><button id="discover">↻</button></div><div id="endpoints" class="section-body"></div></section>
    </div>
  </aside>
  <main>
    <header id="mainHead"><div id="title">navapi</div><div id="status"></div><button id="quit" class="danger">Quit</button></header>
    <div id="content"><div class="hero"><h1>Business Central APIs, without the ceremony.</h1><p>Select or create a profile, choose a company, then discover the APIs exposed by the environment.</p></div></div>
  </main>
</div>

<dialog id="profileDialog">
  <div class="dialog-head"><h2 id="profileHeading">Add profile</h2></div>
  <div class="dialog-body">
    <div class="form-grid">
      <label for="pName">Profile name</label><input id="pName" autocomplete="off">
      <label for="pTenant">Tenant</label><input id="pTenant" autocomplete="off">
      <label for="pClient">Client ID</label><input id="pClient" autocomplete="off">
      <label for="pSecret">Client secret</label><input id="pSecret" type="password" autocomplete="new-password">
      <label for="pEnvironment">Environment</label><input id="pEnvironment" value="Production">
      <label for="pCompany">Default company</label><input id="pCompany" list="companyOptions">
      <label for="pBaseUrl">API base URL</label><input id="pBaseUrl" placeholder="https://api.businesscentral.dynamics.com">
    </div>
    <datalist id="companyOptions"></datalist>
    <p id="profileStatus" class="meta"></p>
  </div>
  <div class="dialog-actions"><button id="deleteProfile" class="danger">Delete</button><span class="grow"></span><button id="cancelProfile">Cancel</button><button id="testProfile">Test connection</button><button id="saveProfile" class="primary">Save</button></div>
</dialog>

<dialog id="dataDialog">
  <div class="dialog-head"><h2 id="dataHeading"></h2></div>
  <div class="dialog-body"><pre id="dataText"></pre></div>
  <div class="dialog-actions"><button id="closeData">Close</button></div>
</dialog>

<dialog id="detailDialog">
  <div class="dialog-head"><h2 id="detailHeading">Record</h2></div>
  <div class="dialog-body"><div id="detailFields"></div><div id="navButtons" class="toolbar"></div><div id="navResult"></div></div>
  <div class="dialog-actions"><button id="closeDetail">Close</button></div>
</dialog>

<script nonce="${nonce}">
(() => {
  'use strict';
  const VERSION = ${escapeJson(version)};
  const launchProfile = new URLSearchParams(location.search).get('profile') || undefined;
  const fragmentToken = location.hash.slice(1);
  if (fragmentToken) sessionStorage.setItem('navapi.sessionToken', fragmentToken);
  const token = fragmentToken || sessionStorage.getItem('navapi.sessionToken') || '';
  if (fragmentToken) history.replaceState(null, '', location.pathname);
  const state = { profiles: [], defaultProfile: undefined, profile: undefined, routes: [], entity: undefined, route: undefined, records: [], cursor: undefined, query: {}, queryUrl: '', filterRows: [], manualFilter: false };
  const el = (id) => document.getElementById(id);

  async function api(path, options = {}) {
    const headers = { authorization: 'Bearer ' + token, ...options.headers };
    if (options.body && typeof options.body !== 'string') {
      headers['content-type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }
    const response = await fetch(path, { ...options, headers });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Request failed (' + response.status + ')');
    return body;
  }
  function setStatus(text, bad = false) { el('status').textContent = text || ''; el('status').className = bad ? 'error' : ''; }
  function text(tag, value, cls) { const node = document.createElement(tag); node.textContent = String(value ?? ''); if (cls) node.className = cls; return node; }
  function button(label, action, cls) { const node = text('button', label, cls); node.addEventListener('click', action); return node; }
  function treeIcon(kind) {
    const codicon = kind === 'route' ? 'plug' : 'symbol-class';
    const icon = text('span', '', 'tree-icon codicon codicon-' + codicon);
    icon.dataset.codicon = codicon; icon.setAttribute('aria-hidden','true');
    return icon;
  }
  function showError(error) { setStatus(error instanceof Error ? error.message : String(error), true); }
  for (const toggle of document.querySelectorAll('.section-toggle')) {
    toggle.addEventListener('click',()=>{const body=el(toggle.getAttribute('aria-controls'));const expanded=toggle.getAttribute('aria-expanded')==='true';toggle.setAttribute('aria-expanded',String(!expanded));toggle.closest('.section').classList.toggle('collapsed',expanded);body.hidden=expanded;});
  }

  async function loadState(preferred) {
    const data = await api('/api/state');
    state.profiles = data.profiles;
    state.defaultProfile = data.defaultProfile;
    const wanted = preferred || state.profile || data.preferredProfile || data.defaultProfile;
    state.profile = data.profiles.find((profile) => profile.name === wanted)?.name || data.profiles[0]?.name;
    el('companiesProfile').textContent = state.profile || '';
    el('endpointsProfile').textContent = state.profile || '';
    renderProfiles();
    if (state.profile) await Promise.all([loadCompanies(), loadDiscovery(false)]);
    else { el('companies').replaceChildren(text('div', 'No profile', 'meta')); el('endpoints').replaceChildren(text('div', 'No profile', 'meta')); }
  }

  function renderProfiles() {
    const host = el('profiles'); host.replaceChildren();
    for (const profile of state.profiles) {
      const node = document.createElement('button'); node.className = 'item' + (profile.name === state.profile ? ' active' : '');
      node.append(text('span', profile.name + (profile.name === state.defaultProfile ? ' ★' : '')), text('small', profile.environment + (profile.company ? ' · ' + profile.company : '')));
      node.title = profile.tenantId;
      node.addEventListener('click', async () => { state.profile = profile.name; await api('/api/profiles/' + encodeURIComponent(profile.name) + '/default', { method:'POST' }); await loadState(profile.name); });
      node.addEventListener('contextmenu', (event) => { event.preventDefault(); openProfile(profile); });
      host.appendChild(node);
    }
    if (!state.profiles.length) host.appendChild(text('div', 'Add a profile to begin.', 'meta'));
  }

  async function loadCompanies() {
    const host = el('companies'); host.replaceChildren(text('div', 'Loading…', 'meta'));
    try {
      const data = await api('/api/companies?profile=' + encodeURIComponent(state.profile));
      host.replaceChildren();
      for (const company of data.companies) {
        const node = document.createElement('button'); node.className = 'item' + (company.isDefault ? ' active' : '');
        node.append(text('span', company.label + (company.isDefault ? ' ★' : '')), text('small', company.name));
        node.addEventListener('click', async () => {
          await api('/api/profiles/' + encodeURIComponent(state.profile) + '/company', { method:'POST', body:{ company: company.id || company.name } });
          await loadState(state.profile);
        });
        host.appendChild(node);
      }
      if (!data.companies.length) host.appendChild(text('div', 'No companies returned.', 'meta'));
    } catch (error) { host.replaceChildren(text('div', error.message, 'error')); }
  }

  async function loadDiscovery(refresh) {
    const host = el('endpoints'); host.replaceChildren(text('div', refresh ? 'Discovering…' : 'Loading…', 'meta'));
    try {
      const data = await api('/api/discovery?profile=' + encodeURIComponent(state.profile) + '&refresh=' + refresh);
      state.routes = data.routes; host.replaceChildren();
      for (const route of data.routes) {
        const group = document.createElement('div'); group.className='route-node';
        const children = document.createElement('div'); children.className='route-children'; children.hidden=true;
        const toggle = document.createElement('button'); toggle.className='item route-toggle'; toggle.type='button'; toggle.setAttribute('aria-expanded','false');
        const chevron = text('span','','chevron');
        toggle.append(chevron,treeIcon('route'),text('span',route.routePath,'label'),text('span',route.metadata.entitySets.length + ' entity sets','route-count'));
        toggle.addEventListener('click',()=>{const expanded=toggle.getAttribute('aria-expanded')==='true';toggle.setAttribute('aria-expanded',String(!expanded));children.hidden=expanded;});
        for (const entity of route.metadata.entitySets) {
          const node = document.createElement('button'); node.className='item entity'; node.type='button';
          node.append(treeIcon('entity'),text('span',entity.name,'label'));
          node.title = entity.entityType;
          node.addEventListener('click', () => openEntity(route.routePath, entity));
          children.appendChild(node);
        }
        group.append(toggle,children); host.appendChild(group);
      }
      if (data.warning) host.prepend(text('div', data.warning, 'meta'));
      for (const failure of data.errors || []) host.appendChild(text('div', failure.route + ': ' + failure.error, 'error'));
      if (!data.routes.length) host.appendChild(text('div', 'No cached endpoints. Run discovery.', 'meta'));
    } catch (error) { host.replaceChildren(text('div', error.message, 'error')); }
  }

  function openEntity(route, entity) {
    state.route = route; state.entity = entity; state.records = []; state.cursor = undefined; state.query = {}; state.filterRows = []; state.manualFilter = false;
    el('title').textContent = entity.name + ' · ' + route + ' · ' + state.profile;
    renderEntity();
    runQuery();
  }

  function renderEntity() {
    const host = el('content'); host.replaceChildren();
    const toolbar = document.createElement('div'); toolbar.className = 'toolbar';
    const queryToggle = button('Query', toggleQuery); queryToggle.id = 'queryToggle';
    toolbar.append(queryToggle, button('Schema', showSchema), button('Open as JSON', showJson), text('span', '', 'grow'));
    const meta = text('span', '', 'meta'); meta.id = 'recordMeta'; toolbar.append(meta);
    host.append(toolbar);
    const query = document.createElement('div'); query.className = 'query';
    const rowHost = document.createElement('div'); rowHost.id = 'filterRows'; query.append(rowHost);
    const actions = document.createElement('div'); actions.className = 'toolbar';
    const combinator = document.createElement('select'); combinator.id = 'combinator'; combinator.append(new Option('all (and)', 'and'), new Option('any (or)', 'or'));
    combinator.addEventListener('change', () => { state.manualFilter=false; updateFilterPreview(); });
    actions.append(button('+ Add condition', addFilterRow), text('span', 'Match', 'meta'), combinator, text('span', '', 'grow'), button('Apply', () => runQuery(), 'primary'), button('Clear', clearQuery));
    query.append(actions);
    const expression = document.createElement('input'); expression.id = 'filterExpression'; expression.className = 'query-input'; expression.spellcheck = false;
    expression.addEventListener('input', () => { state.manualFilter = true; });
    query.append(text('label', 'OData $filter (generated — edit to take over)', 'query-label'), expression);
    const picks = document.createElement('div'); picks.className = 'field-picks'; picks.id = 'fieldPicks';
    for (const field of state.entity.properties) {
      const label = document.createElement('label'); const check = document.createElement('input'); check.type='checkbox'; check.value=field.name;
      label.append(check, document.createTextNode(' ' + field.name)); picks.append(label);
    }
    query.append(text('label', 'Fields ($select) — none checked = all fields', 'query-label'), picks);
    const urlRow = document.createElement('div'); urlRow.className = 'url-row';
    const queryUrl = document.createElement('input'); queryUrl.id = 'queryUrl'; queryUrl.className = 'query-input'; queryUrl.readOnly = true; queryUrl.spellcheck = false;
    urlRow.append(queryUrl, button('Copy', copyQueryUrl));
    query.append(text('label', 'Query URL', 'query-label'), urlRow);
    host.append(query);
    const grid = document.createElement('div'); grid.id='grid'; host.append(grid);
    renderFilterRows();
  }

  function operators(type) {
    if (type === 'Edm.Boolean' || type === 'Edm.Guid') return ['eq','ne'];
    if (/^Edm\\.(Decimal|Double|Single|Int|Byte|SByte|Date|Time)/.test(type)) return ['eq','ne','gt','ge','lt','le'];
    return ['contains','eq','ne','startswith','endswith'];
  }
  function filterExpression() {
    return state.filterRows
      .filter((row) => row.field && row.op && row.value.trim() !== '')
      .map((row) => {
        const raw = /^(Edm\\.(Boolean|Byte|Date|DateTimeOffset|Decimal|Double|Guid|Int16|Int32|Int64|SByte|Single|TimeOfDay))$/.test(row.type);
        const value = raw ? row.value.trim() : "'" + row.value.trim().replaceAll("'", "''") + "'";
        return ['contains','startswith','endswith'].includes(row.op) ? row.op + '(' + row.field + ',' + value + ')' : row.field + ' ' + row.op + ' ' + value;
      })
      .join(' ' + (el('combinator')?.value || 'and') + ' ');
  }
  function updateFilterPreview() {
    if (!state.manualFilter) el('filterExpression').value = filterExpression();
  }
  function addFilterRow() {
    const field = state.entity.properties[0];
    if (!field) return;
    state.filterRows.push({ field:field.name, type:field.type, op:operators(field.type)[0], value:'' });
    state.manualFilter = false; renderFilterRows(); updateFilterPreview();
  }
  function toggleQuery() {
    const panel = document.querySelector('.query'); panel.classList.toggle('open');
    el('queryToggle').classList.toggle('primary', panel.classList.contains('open'));
    if (panel.classList.contains('open') && !state.filterRows.length && !el('filterExpression').value) addFilterRow();
  }
  function clearQuery() {
    state.filterRows=[]; state.query={}; state.manualFilter=false;
    el('filterExpression').value=''; for (const pick of document.querySelectorAll('#fieldPicks input')) pick.checked=false;
    renderFilterRows(); runQuery();
  }
  function renderFilterRows() {
    const host = el('filterRows'); if (!host) return; host.replaceChildren();
    state.filterRows.forEach((filter, index) => {
      const row = document.createElement('div'); row.className='query-row';
      const field = document.createElement('select');
      for (const info of state.entity.properties) field.append(new Option(info.name, info.name));
      field.value=filter.field; field.addEventListener('change', () => { const info=state.entity.properties.find((item)=>item.name===field.value); filter.field=field.value; filter.type=info?.type || 'Edm.String'; filter.op=operators(filter.type)[0]; filter.value=''; state.manualFilter=false; renderFilterRows(); updateFilterPreview(); });
      const op = document.createElement('select'); for (const name of operators(filter.type)) op.append(new Option(name,name)); op.value=filter.op; op.addEventListener('change',()=>{filter.op=op.value;state.manualFilter=false;updateFilterPreview();});
      const value = document.createElement('input'); value.value=filter.value; value.placeholder=filter.type.replace('Edm.',''); value.addEventListener('input',()=>{filter.value=value.value;state.manualFilter=false;updateFilterPreview();});
      row.append(field,op,value,button('×',()=>{state.filterRows.splice(index,1);state.manualFilter=false;renderFilterRows();updateFilterPreview();})); host.append(row);
    });
  }

  async function runQuery(orderby) {
    if (!state.entity) return;
    const select = [...document.querySelectorAll('#fieldPicks input:checked')].map((node)=>node.value);
    state.query = { filterRows:state.filterRows, combinator:el('combinator')?.value || 'and', filter:el('filterExpression')?.value || '', manualFilter:state.manualFilter, select, orderby:orderby || state.query.orderby };
    setStatus('Loading records…');
    try {
      const data = await api('/api/query', { method:'POST', body:{ profile:state.profile, route:state.route, entity:state.entity.name, ...state.query } });
      state.records=data.records; state.cursor=data.cursor; state.query.orderby=data.orderby; state.queryUrl=data.queryUrl; if(el('queryUrl'))el('queryUrl').value=data.queryUrl; renderGrid(data); setStatus('');
    } catch (error) { showError(error); el('grid').replaceChildren(text('div', error.message, 'error')); }
  }

  function renderGrid(data) {
    el('recordMeta').textContent = data.totalCount === undefined ? data.records.length + ' records' : data.records.length + ' of ' + data.totalCount + ' records';
    const host=el('grid'); host.replaceChildren();
    if (!data.grid.rows.length) { host.append(text('div','No records found.','empty')); return; }
    const wrap=document.createElement('div'); wrap.className='table-wrap'; const table=document.createElement('table'); const head=document.createElement('thead'); const hr=document.createElement('tr');
    data.grid.columns.forEach((column)=>{ const sortable=state.entity.properties.some((field)=>field.name===column); const th=text('th',column + (data.orderby?.field===column ? (data.orderby.dir==='asc'?' ▲':' ▼') : '')); if(sortable)th.addEventListener('click',()=>runQuery({field:column,dir:data.orderby?.field===column&&data.orderby.dir==='asc'?'desc':'asc'})); else th.classList.add('nonsort'); hr.append(th); });
    head.append(hr); table.append(head); const body=document.createElement('tbody');
    data.grid.rows.forEach((cells,index)=>{ const row=document.createElement('tr'); cells.forEach((cell)=>{ const td=document.createElement('td'); const value=text('span',cell.text,cell.nested?'chip':undefined); if(cell.nested)value.title='Nested value'; td.append(value); row.append(td); }); row.addEventListener('click',()=>showDetail(index)); body.append(row); });
    table.append(body); wrap.append(table); host.append(wrap);
    if (state.cursor) host.append(button('Load more', loadMore, 'primary'));
  }

  async function loadMore() {
    try {
      const data=await api('/api/next',{method:'POST',body:{cursor:state.cursor}});
      state.records.push(...data.records); state.cursor=data.cursor;
      renderGrid({ ...data, records:state.records, grid:data.combinedGrid, totalCount:data.totalCount, orderby:state.query.orderby });
    } catch(error){showError(error);}
  }

  function showDetail(index) {
    const record=state.records[index]; el('detailHeading').textContent=state.entity.name; const fields=el('detailFields'); fields.replaceChildren();
    for(const [key,value] of Object.entries(record)){ if(key.startsWith('@'))continue; fields.append(text('b',key),text('span',typeof value==='object'?JSON.stringify(value):value)); }
    const nav=el('navButtons'); nav.replaceChildren();
    for(const item of state.entity.navigationProperties) nav.append(button(item.name,()=>loadNavigation(record,item.name)));
    el('navResult').replaceChildren(); el('detailDialog').showModal();
  }

  async function loadNavigation(record, nav) {
    const host=el('navResult'); host.replaceChildren(text('div','Loading ' + nav + '…','meta'));
    try {
      const keys=state.entity.keys?.length ? state.entity.keys : ['id'];
      if(keys.length!==1)throw new Error('Navigation browsing does not support composite entity keys.');
      const key=record[keys[0]];
      if(key===undefined || key===null || key==='')throw new Error('This record does not contain its key field (' + keys[0] + ').');
      const data=await api('/api/navigation',{method:'POST',body:{profile:state.profile,route:state.route,entity:state.entity.name,id:String(key),nav}});
      const pre=text('pre',JSON.stringify(data.records,null,2)); host.replaceChildren(text('h3',nav),pre);
    } catch(error){host.replaceChildren(text('div',error.message,'error'));}
  }

  function showSchema() { el('dataHeading').textContent='Schema · ' + state.entity.name; el('dataText').textContent=JSON.stringify(state.entity,null,2); el('dataDialog').showModal(); }
  function showJson() { el('dataHeading').textContent='Records · ' + state.entity.name; el('dataText').textContent=JSON.stringify(state.records,null,2); el('dataDialog').showModal(); }
  async function copyQueryUrl() { if (!state.queryUrl) return; try { await navigator.clipboard.writeText(state.queryUrl); setStatus('Query URL copied.'); } catch { setStatus('The browser did not allow clipboard access.', true); } }

  function profileValues() { return { name:el('pName').value.trim(), tenantId:el('pTenant').value.trim(), clientId:el('pClient').value.trim(), clientSecret:el('pSecret').value, environment:el('pEnvironment').value.trim(), company:el('pCompany').value.trim(), baseUrl:el('pBaseUrl').value.trim() }; }
  function openProfile(profile) {
    const values=profile || {}; el('profileHeading').textContent=profile?'Edit profile':'Add profile';
    for(const [id,key] of [['pName','name'],['pTenant','tenantId'],['pClient','clientId'],['pEnvironment','environment'],['pCompany','company'],['pBaseUrl','baseUrl']]) el(id).value=values[key] || (id==='pEnvironment'?'Production':'');
    el('pSecret').value=''; el('pSecret').placeholder=profile?.hasSecret?'Unchanged if left blank':''; el('pName').readOnly=Boolean(profile); el('deleteProfile').classList.toggle('hidden',!profile); el('profileDialog').dataset.original=profile?.name || ''; el('profileStatus').textContent=''; el('profileDialog').showModal();
  }
  async function testProfile() {
    const status=el('profileStatus'); status.textContent='Connecting…'; status.className='meta';
    try { const data=await api('/api/profiles/test',{method:'POST',body:{profile:profileValues(),originalName:el('profileDialog').dataset.original||undefined}}); status.textContent='Connected · ' + data.companies.length + ' companies'; status.className='ok'; const list=el('companyOptions'); list.replaceChildren(); data.companies.forEach((company)=>list.append(new Option(company.label,company.label))); }
    catch(error){status.textContent=error.message;status.className='error';}
  }
  async function saveProfile() {
    try { const data=await api('/api/profiles',{method:'POST',body:{profile:profileValues(),originalName:el('profileDialog').dataset.original||undefined}}); el('profileDialog').close(); await loadState(data.name); }
    catch(error){el('profileStatus').textContent=error.message;el('profileStatus').className='error';}
  }
  async function deleteProfile() {
    const name=el('profileDialog').dataset.original; if(!name || !confirm('Delete profile "' + name + '" and its stored secret and metadata cache?')) return;
    try { await api('/api/profiles/' + encodeURIComponent(name),{method:'DELETE'}); el('profileDialog').close(); state.profile=undefined; await loadState(); }
    catch(error){el('profileStatus').textContent=error.message;el('profileStatus').className='error';}
  }

  el('addProfile').addEventListener('click',()=>openProfile());
  el('editProfile').addEventListener('click',()=>{const profile=state.profiles.find((item)=>item.name===state.profile);if(profile)openProfile(profile);});
  el('refreshCompanies').addEventListener('click',()=>state.profile&&loadCompanies());
  el('discover').addEventListener('click',()=>state.profile&&loadDiscovery(true));
  el('quit').addEventListener('click',async()=>{ try{await api('/api/quit',{method:'POST'});}finally{document.body.replaceChildren(text('div','navapi has stopped. You can close this tab.','hero'));} });
  el('cancelProfile').addEventListener('click',()=>el('profileDialog').close());
  el('testProfile').addEventListener('click',testProfile); el('saveProfile').addEventListener('click',saveProfile); el('deleteProfile').addEventListener('click',deleteProfile);
  el('closeData').addEventListener('click',()=>el('dataDialog').close()); el('closeDetail').addEventListener('click',()=>el('detailDialog').close());
  const heartbeat=()=>api('/api/heartbeat',{method:'POST'}).catch(()=>{});
  setInterval(heartbeat,5000);
  document.addEventListener('visibilitychange',heartbeat);
  loadState(launchProfile).catch(showError);
})();
</script>
</body>
</html>`;
}
