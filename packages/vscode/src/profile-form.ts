import {
  AzureCliAuth,
  activeAzureCliAccount,
  BcClient,
  type BcRecord,
  ClientCredentialsAuth,
  type CredentialType,
  companyLabel,
  defaultConfigDir,
  listAzureCliAccounts,
  ProfileStore,
  type ResolvedProfile,
  resolveSecretStore,
} from '@navapi/core';
import * as vscode from 'vscode';
import { saveCompanies } from './companies-cache.js';
import { type FormInit, type ProfileFormValues, renderFormHtml } from './profile-form-html.js';
import { getNonce } from './webview.js';

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
      credential: values.credential || values.name || '__test__',
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
  static show(
    onSaved: () => void,
    existing?: ResolvedProfile,
    hasStoredSecret = false,
    sharedWith: string[] = [],
  ): void {
    new ProfileFormPanel(onSaved, existing, hasStoredSecret, sharedWith);
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly mode: 'add' | 'edit';
  private readonly originalName?: string;
  private readonly originalAuthType?: CredentialType;

  private constructor(
    private readonly onSaved: () => void,
    existing?: ResolvedProfile,
    hasStoredSecret = false,
    sharedWith: string[] = [],
  ) {
    this.mode = existing ? 'edit' : 'add';
    this.originalName = existing?.name;
    this.originalAuthType = existing?.resolvedCredential.type;
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
        credential: existing?.credential ?? '',
        sharedWith,
        authType: existing?.resolvedCredential.type === 'azureCli' ? 'azureCli' : 'clientSecret',
        clientId:
          existing?.resolvedCredential.type === 'clientSecret'
            ? existing.resolvedCredential.clientId
            : '',
        clientSecret: '',
        azAccount:
          existing?.resolvedCredential.type === 'azureCli'
            ? (existing.resolvedCredential.account ?? '')
            : '',
        environment: existing?.environment ?? '',
        company: existing?.company ?? '',
        baseUrl: existing?.baseUrl ?? '',
        readOnly: Boolean(existing?.readOnly),
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
        // Same as the CLI: a broken active account costs the marker, not the list.
        activeAzureCliAccount().catch(() => undefined),
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

  /**
   * Switching an existing profile from a client secret to az CLI auth leaves a
   * secret behind that nothing uses. Say so rather than saving silently — but
   * don't delete it: an Entra client secret is shown once at creation, so a
   * mistaken switch would be unrecoverable. The delete is one deliberate click.
   */
  private async announceSaved(name: string, values: ProfileFormValues): Promise<void> {
    const dir = defaultConfigDir();
    const orphaned =
      this.originalAuthType === 'clientSecret' &&
      isAzureCli(values) &&
      (await (await resolveSecretStore(dir)).store.get(name)) !== undefined;
    if (!orphaned) {
      vscode.window.showInformationMessage(`navapi: profile "${name}" saved.`);
      return;
    }
    const remove = 'Delete Stored Secret';
    const choice = await vscode.window.showInformationMessage(
      `navapi: profile "${name}" saved. Azure CLI auth requires no secret — ` +
        'the previous client secret is kept in case you switch back.',
      remove,
    );
    if (choice !== remove) return;
    await (await resolveSecretStore(dir)).store.delete(name);
    vscode.window.showInformationMessage(`navapi: stored secret for "${name}" deleted.`);
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
      // A profile that already points at a credential keeps pointing at it,
      // so editing one profile of a shared credential updates the identity
      // once rather than forking a copy per profile. A new profile mints a
      // credential named after itself, matching the CLI and the migration.
      const credentialName = values.credential || name;
      await store.upsertWithCredential(
        {
          name,
          tenantId: values.tenantId,
          environment: values.environment,
          company: values.company || undefined,
          baseUrl: values.baseUrl || undefined,
          readOnly: values.readOnly ? true : undefined,
        },
        isAzureCli(values)
          ? { name: credentialName, type: 'azureCli', account: values.azAccount || undefined }
          : { name: credentialName, type: 'clientSecret', clientId: values.clientId },
      );
      if (secret) await (await resolveSecretStore(dir)).store.set(credentialName, secret);
      // A successful test already fetched companies; cache them for the tree.
      try {
        await saveCompanies(name, await testConnection(values, secret));
      } catch {
        // saving still succeeds if the environment is briefly unreachable
      }
      this.onSaved();
      void this.announceSaved(name, values);
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
