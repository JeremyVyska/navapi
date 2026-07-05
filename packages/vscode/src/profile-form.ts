import {
  BcClient,
  type BcRecord,
  ClientCredentialsAuth,
  companyLabel,
  defaultConfigDir,
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
  clientId: string;
  clientSecret: string;
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

/** Connects with the form's values (not saved state) and returns the companies. */
async function testConnection(values: ProfileFormValues, secret: string): Promise<BcRecord[]> {
  const client = new BcClient({
    profile: {
      name: values.name || '__test__',
      tenantId: values.tenantId,
      clientId: values.clientId,
      environment: values.environment,
      baseUrl: values.baseUrl || undefined,
    },
    auth: new ClientCredentialsAuth({
      tenantId: values.tenantId,
      clientId: values.clientId,
      clientSecret: secret,
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
        clientId: existing?.clientId ?? '',
        clientSecret: '',
        environment: existing?.environment ?? '',
        company: existing?.company ?? '',
        baseUrl: existing?.baseUrl ?? '',
      },
    };
    this.panel.webview.html = renderFormHtml(init, getNonce());
    this.panel.webview.onDidReceiveMessage((msg: { type?: string; values?: ProfileFormValues }) => {
      if (msg?.type === 'test' && msg.values) void this.handleTest(msg.values);
      if (msg?.type === 'save' && msg.values) void this.handleSave(msg.values);
    });
  }

  /** The form secret, or the stored one when editing with the field left blank. */
  private async resolveSecret(values: ProfileFormValues): Promise<string | undefined> {
    if (values.clientSecret) return values.clientSecret;
    if (this.mode === 'edit' && this.originalName) {
      const { store } = await resolveSecretStore(defaultConfigDir());
      return store.get(this.originalName);
    }
    return undefined;
  }

  private async handleTest(values: ProfileFormValues): Promise<void> {
    try {
      const secret = await this.resolveSecret(values);
      if (!secret) throw new Error('Enter a client secret first.');
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
      if (!secret) throw new Error('A client secret is required.');
      const name = this.mode === 'edit' && this.originalName ? this.originalName : values.name;
      await store.upsert({
        name,
        tenantId: values.tenantId,
        clientId: values.clientId,
        environment: values.environment,
        company: values.company || undefined,
        baseUrl: values.baseUrl || undefined,
      });
      await (await resolveSecretStore(dir)).store.set(name, secret);
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
  input { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 5px 8px; border-radius: 2px; }
  input:focus { outline: 1px solid var(--vscode-focusBorder); }
  input[readonly] { opacity: .6; }
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

  <label for="clientId">Client ID <span class="hint">— app registration</span></label>
  <input id="clientId">

  <label for="clientSecret">Client secret</label>
  <input id="clientSecret" type="password">

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
    const FIELDS = ['name', 'tenantId', 'clientId', 'clientSecret', 'environment', 'company', 'baseUrl'];
    const REQUIRED = ['name', 'tenantId', 'clientId', 'environment'];
    const el = (id) => document.getElementById(id);

    document.getElementById('heading').textContent =
      init.mode === 'edit' ? 'Edit Profile: ' + init.values.name : 'Add Profile';
    el('save').textContent = init.mode === 'edit' ? 'Save Changes' : 'Save Profile';
    for (const f of FIELDS) el(f).value = init.values[f];
    if (init.mode === 'edit') {
      el('name').readOnly = true;
      if (init.hasStoredSecret) el('clientSecret').placeholder = '(unchanged — leave blank to keep)';
    }

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
      const must = REQUIRED.slice();
      if (needSecret && !(init.mode === 'edit' && init.hasStoredSecret)) must.push('clientSecret');
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
      const must = ['tenantId', 'clientId', 'environment'];
      for (const f of FIELDS) el(f).classList.remove('invalid');
      let bad = false;
      for (const f of must) if (!el(f).value.trim()) { el(f).classList.add('invalid'); bad = true; }
      if (bad) { setStatus('Tenant, client ID, and environment are needed to test.', false); return; }
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
      if (msg.type === 'saveResult' && !msg.ok) {
        el('save').disabled = false;
        setStatus(msg.message, false);
      }
    });
  </script>
</body>
</html>`;
}
