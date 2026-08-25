import {
  AzureCliAuth,
  activeAzureCliAccount,
  BcClient,
  type BcRecord,
  ClientCredentialsAuth,
  companyLabel,
  defaultConfigDir,
  listAzureCliAccounts,
  type ProfileConfig,
  ProfileStore,
  resolveSecretStore,
} from '@navapi/core';
import * as vscode from 'vscode';
import { saveCompanies } from './companies-cache.js';
import { getNonce } from './webview.js';

export interface ProfileFormValues {
  name: string;
  tenantId: string;
  authType: 'clientCredentials' | 'azureCli';
  clientId: string;
  clientSecret: string;
  azAccount: string;
  environment: string;
  company: string;
  baseUrl: string;
}

interface FormInit {
  mode: 'add' | 'edit';
  values: ProfileFormValues;
  hasStoredSecret: boolean;
}

function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028')
    .replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029');
}

const isAzureCli = (values: ProfileFormValues): boolean => values.authType === 'azureCli';

/** Connects with the form's values (not saved state) and returns the companies. */
async function testConnection(
  values: ProfileFormValues,
  secret: string | undefined,
): Promise<BcRecord[]> {
  const client = new BcClient({
    profile: {
      name: values.name || '__test__',
      tenantId: values.tenantId,
      authType: values.authType,
      clientId: isAzureCli(values) ? undefined : values.clientId,
      azAccount: isAzureCli(values) ? values.azAccount || undefined : undefined,
      environment: values.environment,
      baseUrl: values.baseUrl || undefined,
    },
    auth: isAzureCli(values)
      ? new AzureCliAuth({ tenantId: values.tenantId, account: values.azAccount || undefined })
      : new ClientCredentialsAuth({
          tenantId: values.tenantId,
          clientId: values.clientId,
          clientSecret: secret ?? '',
          authorityBase: process.env.NAVAPI_AUTHORITY,
        }),
  });
  return client.listCompanies();
}

/**
 * Add/Edit Profile as a real form in an editor tab: every field visible,
 * inline validation, Test Connection before saving, and a company picker
 * fed by the environment's actual company list.
 */
export class ProfileFormPanel {
  static show(onSaved: () => void, existing?: ProfileConfig, hasStoredSecret = false): void {
    new ProfileFormPanel(onSaved, existing, hasStoredSecret);
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly mode: 'add' | 'edit';
  private readonly originalName?: string;

  private constructor(
    private readonly onSaved: () => void,
    existing?: ProfileConfig,
    hasStoredSecret = false,
  ) {
    this.mode = existing ? 'edit' : 'add';
    this.originalName = existing?.name;
    this.panel = vscode.window.createWebviewPanel(
      'navapiProfileForm',
      existing ? `Edit Profile: ${existing.name}` : 'Add Profile',
      vscode.ViewColumn.Active,
      { enableScripts: true },
    );
    const init: FormInit = {
      mode: this.mode,
      hasStoredSecret,
      values: {
        name: existing?.name ?? '',
        tenantId: existing?.tenantId ?? '',
        authType: existing?.authType ?? 'clientCredentials',
        clientId: existing?.clientId ?? '',
        clientSecret: '',
        azAccount: existing?.azAccount ?? '',
        environment: existing?.environment ?? '',
        company: existing?.company ?? '',
        baseUrl: existing?.baseUrl ?? '',
      },
    };
    this.panel.webview.html = renderFormHtml(init, getNonce());
    this.panel.webview.onDidReceiveMessage((msg: { type?: string; values?: ProfileFormValues }) => {
      if (msg?.type === 'azAccounts') void this.handleAzAccounts();
      if (msg?.type === 'test' && msg.values) void this.handleTest(msg.values);
      if (msg?.type === 'save' && msg.values) void this.handleSave(msg.values);
    });
  }

  /** The form secret, or the stored one when editing with the field left blank. */
  private async resolveSecret(values: ProfileFormValues): Promise<string | undefined> {
    if (isAzureCli(values)) return undefined; // az CLI auth has no secret
    if (values.clientSecret) return values.clientSecret;
    if (this.mode === 'edit' && this.originalName) {
      const { store } = await resolveSecretStore(defaultConfigDir());
      return store.get(this.originalName);
    }
    return undefined;
  }

  /** Feeds the identity picker, so nobody has to remember their az accounts. */
  private async handleAzAccounts(): Promise<void> {
    try {
      const [accounts, active] = await Promise.all([
        listAzureCliAccounts(),
        activeAzureCliAccount(),
      ]);
      // Collapse to identities: the same one often reaches tenants az holds no
      // account in, so listing it per tenant suggests a binding that isn't real.
      const identities = [...new Set(accounts.map((a) => a.user))].map((user) => ({
        user,
        current: user.toLowerCase() === active?.user.toLowerCase(),
      }));
      if (active && !identities.some((i) => i.current)) {
        identities.push({ user: active.user, current: true });
      }
      await this.panel.webview.postMessage({ type: 'azAccountsResult', ok: true, identities });
    } catch (err) {
      await this.panel.webview.postMessage({
        type: 'azAccountsResult',
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handleTest(values: ProfileFormValues): Promise<void> {
    try {
      const secret = await this.resolveSecret(values);
      if (!secret && !isAzureCli(values)) throw new Error('Enter a client secret first.');
      const companies = await testConnection(values, secret);
      await this.panel.webview.postMessage({
        type: 'testResult',
        ok: true,
        message: `Connected — ${companies.length} ${companies.length === 1 ? 'company' : 'companies'} found.`,
        companies: companies.map((c) => ({
          label: companyLabel(c),
          name: String(c.name ?? ''),
        })),
      });
    } catch (err) {
      await this.panel.webview.postMessage({
        type: 'testResult',
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handleSave(values: ProfileFormValues): Promise<void> {
    try {
      const dir = defaultConfigDir();
      const store = new ProfileStore(dir);
      if (this.mode === 'add') {
        const { profiles } = await store.listAll();
        if (profiles.some((p) => p.name === values.name)) {
          throw new Error(`Profile "${values.name}" already exists — use Edit Profile instead.`);
        }
      }
      const secret = await this.resolveSecret(values);
      if (!secret && !isAzureCli(values)) throw new Error('A client secret is required.');
      const name = this.mode === 'edit' && this.originalName ? this.originalName : values.name;
      await store.upsert({
        name,
        tenantId: values.tenantId,
        authType: values.authType,
        clientId: isAzureCli(values) ? undefined : values.clientId,
        azAccount: isAzureCli(values) ? values.azAccount || undefined : undefined,
        environment: values.environment,
        company: values.company || undefined,
        baseUrl: values.baseUrl || undefined,
      });
      if (secret) await (await resolveSecretStore(dir)).store.set(name, secret);
      // A successful test already fetched companies; cache them for the tree.
      try {
        await saveCompanies(name, await testConnection(values, secret));
      } catch {
        // saving still succeeds if the environment is briefly unreachable
      }
      this.onSaved();
      vscode.window.showInformationMessage(`navapi: profile "${name}" saved.`);
      this.panel.dispose();
    } catch (err) {
      await this.panel.webview.postMessage({
        type: 'saveResult',
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function renderFormHtml(init: FormInit, nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); max-width: 560px; padding: 20px 24px; }
  h1 { font-size: 16px; margin: 0 0 4px; }
  .sub { color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 20px; }
  label { display: block; font-size: 12px; font-weight: 600; margin: 14px 0 4px; }
  label .hint { font-weight: 400; color: var(--vscode-descriptionForeground); }
  input, select { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 5px 8px; border-radius: 2px; }
  input:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); }
  input[readonly] { opacity: .6; }
  .hidden { display: none; }
  .inline { display: flex; gap: 8px; align-items: center; }
  button.link { background: none; color: var(--vscode-textLink-foreground); padding: 4px 2px; white-space: nowrap; }
  #azAccountStatus { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 4px; min-height: 16px; }
  .row { display: flex; gap: 10px; margin-top: 22px; align-items: center; }
  button { border: none; padding: 6px 14px; border-radius: 2px; cursor: pointer; font-size: 13px; }
  #save { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  #save:hover { background: var(--vscode-button-hoverBackground); }
  #test { background: var(--vscode-button-secondaryBackground, var(--vscode-button-background)); color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground)); }
  button:disabled { opacity: .5; cursor: default; }
  #status { font-size: 12px; margin-top: 14px; min-height: 18px; white-space: pre-wrap; }
  #status.ok { color: var(--vscode-testing-iconPassed, #2ea043); }
  #status.err { color: var(--vscode-errorForeground); }
  .invalid { border-color: var(--vscode-inputValidation-errorBorder, #f14c4c) !important; }
</style>
</head>
<body>
  <h1 id="heading"></h1>
  <div class="sub">One profile pins one Business Central environment. Shared with the navapi CLI and MCP server.</div>

  <label for="name">Profile name</label>
  <input id="name" placeholder="contoso-prod" autofocus>

  <label for="tenantId">Tenant ID <span class="hint">— Entra ID tenant GUID or domain</span></label>
  <input id="tenantId" placeholder="00000000-0000-0000-0000-000000000000">

  <label for="authType">Authentication</label>
  <select id="authType">
    <option value="clientCredentials">App registration (client ID + secret)</option>
    <option value="azureCli">Azure CLI — sign in as myself with az login</option>
  </select>

  <div id="appRegFields">
    <label for="clientId">Client ID <span class="hint">— app registration</span></label>
    <input id="clientId">

    <label for="clientSecret">Client secret</label>
    <input id="clientSecret" type="password">
  </div>

  <div id="azCliFields" class="hidden">
    <label for="azAccount">az identity <span class="hint">— which signed-in account to use</span></label>
    <div class="inline">
      <select id="azAccount"></select>
      <button id="azReload" class="link" type="button">Reload</button>
    </div>
    <div id="azAccountStatus" class="hint"></div>
  </div>

  <div id="azCliNote" class="sub hidden">Uses the identity <code>az login</code> is signed in with — no app registration and no stored secret. You get your own Business Central permissions. An identity reaches a tenant either because <code>az</code> holds an account there, or through delegated admin or a guest invite — and the latter works only while it is the identity signed in now.</div>

  <label for="environment">Environment <span class="hint">— e.g. Production, Sandbox-UAT</span></label>
  <input id="environment" placeholder="Production">

  <label for="company">Default company <span class="hint">— optional; use Test Connection to pick from a list</span></label>
  <input id="company" list="companyOptions" placeholder="CRONUS International Ltd.">
  <datalist id="companyOptions"></datalist>

  <label for="baseUrl">API base URL <span class="hint">— optional, for sovereign clouds</span></label>
  <input id="baseUrl" placeholder="https://api.businesscentral.dynamics.com">

  <div class="row">
    <button id="test">Test Connection</button>
    <button id="save"></button>
  </div>
  <div id="status"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const init = ${embedJson(init)};
    const FIELDS = ['name', 'tenantId', 'authType', 'clientId', 'clientSecret', 'azAccount', 'environment', 'company', 'baseUrl'];
    const el = (id) => document.getElementById(id);
    const azureCli = () => el('authType').value === 'azureCli';
    const required = () =>
      azureCli() ? ['name', 'tenantId', 'environment'] : ['name', 'tenantId', 'clientId', 'environment'];

    document.getElementById('heading').textContent =
      init.mode === 'edit' ? 'Edit Profile: ' + init.values.name : 'Add Profile';
    el('save').textContent = init.mode === 'edit' ? 'Save Changes' : 'Save Profile';
    for (const f of FIELDS) el(f).value = init.values[f];
    if (init.mode === 'edit') {
      el('name').readOnly = true;
      if (init.hasStoredSecret) el('clientSecret').placeholder = '(unchanged — leave blank to keep)';
    }

    let azAccounts = null;

    function requestAzAccounts() {
      el('azAccountStatus').textContent = 'Reading az accounts\u2026';
      vscode.postMessage({ type: 'azAccounts' });
    }

    function renderAzAccounts() {
      const sel = el('azAccount');
      const current = sel.value || init.values.azAccount || '';
      const add = (value, label) => {
        const o = document.createElement('option');
        o.value = value;
        o.textContent = label;
        sel.appendChild(o);
      };
      sel.replaceChildren();
      add('', 'Whichever identity az is signed in as');
      for (const a of (azAccounts || []).slice().sort(
        (a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0) || a.user.localeCompare(b.user)
      )) {
        add(a.user, a.user + (a.current ? ' \u2014 signed in now' : ''));
      }
      // Keep a saved identity selectable even if az no longer reports it.
      if (current && !Array.from(sel.options).some((o) => o.value === current)) {
        add(current, current + ' (saved)');
      }
      sel.value = current;
    }

    el('azReload').addEventListener('click', requestAzAccounts);

    function applyAuthType() {
      el('appRegFields').classList.toggle('hidden', azureCli());
      el('azCliFields').classList.toggle('hidden', !azureCli());
      el('azCliNote').classList.toggle('hidden', !azureCli());
      if (azureCli() && azAccounts === null) requestAzAccounts();
    }
    el('authType').addEventListener('change', () => { applyAuthType(); setStatus('', true); });
    applyAuthType();

    function values() {
      const out = {};
      for (const f of FIELDS) out[f] = el(f).value.trim();
      return out;
    }

    function setStatus(text, ok) {
      const s = el('status');
      s.textContent = text;
      s.className = text ? (ok ? 'ok' : 'err') : '';
    }

    function validate(needSecret) {
      let firstBad;
      const must = required();
      if (needSecret && !azureCli() && !(init.mode === 'edit' && init.hasStoredSecret)) must.push('clientSecret');
      for (const f of FIELDS) el(f).classList.remove('invalid');
      for (const f of must) {
        if (!el(f).value.trim()) {
          el(f).classList.add('invalid');
          firstBad = firstBad || el(f);
        }
      }
      if (firstBad) { firstBad.focus(); setStatus('Fill in the highlighted fields.', false); }
      return !firstBad;
    }

    el('test').addEventListener('click', () => {
      const must = azureCli() ? ['tenantId', 'environment'] : ['tenantId', 'clientId', 'environment'];
      for (const f of FIELDS) el(f).classList.remove('invalid');
      let bad = false;
      for (const f of must) if (!el(f).value.trim()) { el(f).classList.add('invalid'); bad = true; }
      if (bad) {
        setStatus(
          azureCli()
            ? 'Tenant and environment are needed to test.'
            : 'Tenant, client ID, and environment are needed to test.',
          false,
        );
        return;
      }
      el('test').disabled = true;
      setStatus('Connecting…', true);
      vscode.postMessage({ type: 'test', values: values() });
    });

    el('save').addEventListener('click', () => {
      if (!validate(true)) return;
      el('save').disabled = true;
      setStatus('Saving…', true);
      vscode.postMessage({ type: 'save', values: values() });
    });

    window.addEventListener('message', (e) => {
      const msg = e.data || {};
      if (msg.type === 'testResult') {
        el('test').disabled = false;
        setStatus(msg.ok ? msg.message : 'Connection failed: ' + msg.message, msg.ok);
        if (msg.ok && Array.isArray(msg.companies)) {
          const list = el('companyOptions');
          list.replaceChildren();
          for (const c of msg.companies) {
            const opt = document.createElement('option');
            opt.value = c.label;
            list.appendChild(opt);
          }
          if (!el('company').value && msg.companies.length === 1) {
            el('company').value = msg.companies[0].label;
          }
        }
      }
      if (msg.type === 'azAccountsResult') {
        azAccounts = msg.ok ? msg.identities : [];
        el('azAccountStatus').textContent = msg.ok
          ? (msg.identities.length ? '' : 'az is not signed in to any account.')
          : msg.message;
        renderAzAccounts();
      }
      if (msg.type === 'saveResult' && !msg.ok) {
        el('save').disabled = false;
        setStatus(msg.message, false);
      }
    });
  </script>
</body>
</html>`;
}
