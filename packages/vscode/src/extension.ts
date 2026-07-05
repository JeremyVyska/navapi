import {
  BraiderClient,
  type BraiderEndpointSpec,
  type BraiderLineSpec,
  createClientForProfile,
  defaultConfigDir,
  detectBraider,
  ProfileStore,
  resolveSecretStore,
} from '@navapi/core';
import * as vscode from 'vscode';
import { hasBraiderRouteCached, loadBraiderCache } from './braider-cache.js';
import { BraiderPanel } from './braider-panel.js';
import { braiderSchemaDocument } from './braider-view.js';
import { saveCompanies } from './companies-cache.js';
import { schemaDocument } from './model.js';
import { ProfileFormPanel } from './profile-form.js';
import { RecordsPanel } from './records-panel.js';
import {
  activeProfileName,
  type BraiderEndpointNode,
  BraiderProvider,
  CompaniesProvider,
  type CompanyNode,
  EndpointsProvider,
  type EntitySetNode,
  type ProfileNode,
  ProfilesProvider,
} from './tree.js';

const RECORD_PREVIEW_TOP = 50;

/** Refreshes all three sections and keeps their headers on the active profile. */
interface Ui {
  refresh(): Promise<void>;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function openJsonDocument(content: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({ language: 'json', content });
  await vscode.window.showTextDocument(doc, { preview: true });
}

/** Title-bar commands come without a node; fall back to the active profile. */
async function resolveProfileName(node?: ProfileNode): Promise<string> {
  const name = node?.profileName ?? (await activeProfileName());
  if (!name) throw new Error('No profile yet — add one first.');
  return name;
}

async function editProfileFlow(ui: Ui, node: ProfileNode): Promise<void> {
  const dir = defaultConfigDir();
  const profile = await new ProfileStore(dir).get(node.profileName);
  const { store } = await resolveSecretStore(dir);
  const hasSecret = Boolean(await store.get(node.profileName));
  ProfileFormPanel.show(() => void ui.refresh(), profile, hasSecret);
}

async function useProfileFlow(ui: Ui, node: ProfileNode): Promise<void> {
  const store = new ProfileStore(defaultConfigDir());
  const { defaultProfile } = await store.listAll();
  if (defaultProfile !== node.profileName) {
    await store.setDefault(node.profileName);
    vscode.window.setStatusBarMessage(`navapi: active profile is ${node.profileName}`, 6000);
  }
  await ui.refresh();
}

async function selectCompanyFlow(ui: Ui, node: CompanyNode): Promise<void> {
  if (node.isDefault) return;
  const store = new ProfileStore(defaultConfigDir());
  const profile = await store.get(node.profileName);
  await store.upsert({ ...profile, company: node.label });
  await ui.refresh();
  vscode.window.setStatusBarMessage(
    `navapi: ${node.profileName} now uses company "${node.label}"`,
    6000,
  );
}

async function refreshCompaniesFlow(ui: Ui, node?: ProfileNode): Promise<void> {
  const profileName = await resolveProfileName(node);
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `navapi: loading companies for ${profileName}…`,
    },
    async () => {
      const client = await createClientForProfile(profileName);
      await saveCompanies(profileName, await client.listCompanies());
      await ui.refresh();
    },
  );
}

async function discoverFlow(ui: Ui, node?: ProfileNode): Promise<void> {
  const profileName = await resolveProfileName(node);
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `navapi: discovering ${profileName}…`,
    },
    async () => {
      const client = await createClientForProfile(profileName);
      const results = await client.discoverAll({ refresh: true });
      const ok = results.filter((r) => r.metadata).length;
      const failed = results.filter((r) => r.error);
      try {
        // One button populates everything: endpoints and companies.
        await saveCompanies(profileName, await client.listCompanies());
      } catch {
        // companies section will surface its own retry hint
      }
      await ui.refresh();
      if (failed.length) {
        vscode.window.showWarningMessage(
          `navapi: ingested ${ok} route(s); ${failed.length} failed: ${failed
            .map((f) => `${f.route.path} (${f.error})`)
            .join('; ')}`,
        );
      } else {
        vscode.window.showInformationMessage(`navapi: ingested $metadata from ${ok} route(s).`);
      }
    },
  );
}

async function openEntityFlow(node: EntitySetNode): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `navapi: fetching ${node.entitySet.name}…`,
    },
    () => RecordsPanel.show(node),
  );
}

async function openEntityJsonFlow(node: EntitySetNode): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `navapi: fetching ${node.entitySet.name}…`,
    },
    async () => {
      const client = await createClientForProfile(node.profileName);
      const { items, nextLink } = await client.list(node.entitySet.name, {
        route: node.routePath,
        query: { top: RECORD_PREVIEW_TOP },
      });
      await openJsonDocument(JSON.stringify(items, null, 2));
      if (nextLink) {
        vscode.window.setStatusBarMessage(
          `navapi: showing first ${items.length} ${node.entitySet.name} — more exist`,
          8000,
        );
      }
    },
  );
}

async function braiderClientFor(profileName: string): Promise<BraiderClient> {
  const client = await createClientForProfile(profileName);
  const info = await detectBraider(client);
  if (!info) throw new Error('Data Braider is not detected in this environment.');
  return new BraiderClient(client, info);
}

async function braiderSchemaFlow(node: BraiderEndpointNode): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `navapi: loading schema for ${node.endpoint.code}…`,
    },
    async () => {
      const braider = await braiderClientFor(node.profileName);
      const schema = await braider.getEndpointSchema(node.endpoint.code);
      await openJsonDocument(braiderSchemaDocument(schema));
    },
  );
}

async function braiderOpenJsonFlow(node: BraiderEndpointNode): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `navapi: reading ${node.endpoint.code}…`,
    },
    async () => {
      const braider = await braiderClientFor(node.profileName);
      const result = await braider.readEndpoint(node.endpoint.code, { pageSize: 50 });
      await openJsonDocument(JSON.stringify(result.records, null, 2));
      if (result.hasMore) {
        vscode.window.setStatusBarMessage(
          `navapi: showing page 1 of ${node.endpoint.code} — more records exist`,
          8000,
        );
      }
    },
  );
}

/**
 * Guided endpoint authoring: QuickPick dropdowns from the Braider lookup
 * APIs — the user never types table or field numbers. Requires Braider 2.4+.
 */
async function braiderNewEndpointFlow(ui: Ui): Promise<void> {
  const profileName = await resolveProfileName();
  const braider = await braiderClientFor(profileName);
  if (braider.info.level !== 'config') {
    throw new Error('Creating endpoints needs the Data Braider config API (Braider 2.4+).');
  }

  const code = await vscode.window.showInputBox({
    title: 'New Data Braider endpoint (1/4) — code',
    prompt: 'Endpoint code (max 20 chars, e.g. SALESAPI)',
    validateInput: (v) =>
      !v.trim() ? 'Code is required' : v.length > 20 ? 'Max 20 characters' : undefined,
  });
  if (!code) return;

  const typePick = await vscode.window.showQuickPick(
    [
      { label: 'Read Only', description: 'Data out only' },
      { label: 'Per Record', description: 'Writeable — one transaction per record' },
      { label: 'Batch', description: 'Writeable — whole payload in one transaction' },
    ],
    { title: 'New Data Braider endpoint (2/4) — type' },
  );
  if (!typePick) return;

  const lines: BraiderLineSpec[] = [];
  for (;;) {
    const step = `New Data Braider endpoint (3/4) — source table ${lines.length + 1}`;
    const tables = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'navapi: loading tables…' },
      () => braider.listAvailableTables(),
    );
    const tablePick = await vscode.window.showQuickPick(
      tables.map((t) => ({
        label: String(t.caption ?? t.name ?? ''),
        description: `#${t.tableNo}${t.name && t.name !== t.caption ? ` · ${t.name}` : ''}`,
        tableNo: Number(t.tableNo),
      })),
      { title: step, matchOnDescription: true, placeHolder: 'Pick the source table' },
    );
    if (!tablePick) return;

    const fields = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'navapi: loading fields…' },
      () => braider.listAvailableFields(tablePick.tableNo),
    );
    const fieldPicks = await vscode.window.showQuickPick(
      fields.map((f) => ({
        label: String(f.name ?? ''),
        description: `#${f.fieldNo} · ${f.type ?? ''}${f.isPartOfPrimaryKey ? ' · PK' : ''}`,
        picked: Boolean(f.isPartOfPrimaryKey),
        fieldNo: Number(f.fieldNo),
      })),
      {
        title: `${step} — fields to include`,
        canPickMany: true,
        matchOnDescription: true,
        placeHolder: 'Select the fields this endpoint exposes (PK fields preselected)',
      },
    );
    if (!fieldPicks?.length) return;

    lines.push({
      sourceTable: tablePick.tableNo,
      ...(lines.length ? { indentation: 1 } : {}),
      includeFields: fieldPicks.map((f) => f.fieldNo),
    });

    const more = await vscode.window.showQuickPick(
      [
        { label: 'Finish and create', value: false },
        { label: 'Add a child table (indented under the previous)', value: true },
      ],
      { title: 'New Data Braider endpoint (4/4)' },
    );
    if (!more) return;
    if (!more.value) break;
  }

  const spec: BraiderEndpointSpec = {
    code: code.trim().toUpperCase(),
    endpointType: typePick.label as BraiderEndpointSpec['endpointType'],
    lines,
  };
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `navapi: creating endpoint ${spec.code}…`,
    },
    async () => {
      await braider.createEndpoint(spec);
      await ui.refresh();
      vscode.window.showInformationMessage(`navapi: Data Braider endpoint "${spec.code}" created.`);
    },
  );
}

async function removeProfileFlow(ui: Ui, node: ProfileNode): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    `Remove profile "${node.profileName}" (including its stored secret and metadata cache)?`,
    { modal: true },
    'Remove',
  );
  if (confirm !== 'Remove') return;
  const dir = defaultConfigDir();
  await new ProfileStore(dir).remove(node.profileName);
  await (await resolveSecretStore(dir)).store.delete(node.profileName);
  await ui.refresh();
}

/** Wraps a command handler with uniform error reporting. */
function command(fn: (...args: any[]) => Promise<void>): (...args: any[]) => Promise<void> {
  return async (...args: any[]) => {
    try {
      await fn(...args);
    } catch (err) {
      vscode.window.showErrorMessage(`navapi: ${message(err)}`);
    }
  };
}

export function activate(context: vscode.ExtensionContext): void {
  const profiles = new ProfilesProvider();
  const companies = new CompaniesProvider();
  const endpoints = new EndpointsProvider();
  const braider = new BraiderProvider();

  const profilesView = vscode.window.createTreeView('navapi.profiles', {
    treeDataProvider: profiles,
  });
  const companiesView = vscode.window.createTreeView('navapi.companies', {
    treeDataProvider: companies,
  });
  const endpointsView = vscode.window.createTreeView('navapi.endpoints', {
    treeDataProvider: endpoints,
  });
  const braiderView = vscode.window.createTreeView('navapi.braider', {
    treeDataProvider: braider,
  });

  const ui: Ui = {
    async refresh() {
      profiles.refresh();
      companies.refresh();
      endpoints.refresh();
      braider.refresh();
      const active = await activeProfileName();
      companiesView.description = active ?? '';
      endpointsView.description = active ?? '';
      braiderView.description = active ?? '';
      // Offline checks only — no client/secret/network on activation.
      const available = active ? await hasBraiderRouteCached(active) : false;
      await vscode.commands.executeCommand('setContext', 'navapi:braiderAvailable', available);
      const cached = active ? await loadBraiderCache(active) : undefined;
      await vscode.commands.executeCommand(
        'setContext',
        'navapi:braiderConfigApi',
        cached?.info.level === 'config',
      );
    },
  };
  void ui.refresh();

  context.subscriptions.push(
    profilesView,
    companiesView,
    endpointsView,
    braiderView,
    vscode.commands.registerCommand(
      'navapi.refresh',
      command(() => ui.refresh()),
    ),
    vscode.commands.registerCommand(
      'navapi.addProfile',
      command(async () => ProfileFormPanel.show(() => void ui.refresh())),
    ),
    vscode.commands.registerCommand(
      'navapi.editProfile',
      command((node: ProfileNode) => editProfileFlow(ui, node)),
    ),
    vscode.commands.registerCommand(
      'navapi.useProfile',
      command((node: ProfileNode) => useProfileFlow(ui, node)),
    ),
    vscode.commands.registerCommand(
      'navapi.setDefaultProfile',
      command((node: ProfileNode) => useProfileFlow(ui, node)),
    ),
    vscode.commands.registerCommand(
      'navapi.selectCompany',
      command((node: CompanyNode) => selectCompanyFlow(ui, node)),
    ),
    vscode.commands.registerCommand(
      'navapi.refreshCompanies',
      command((node?: ProfileNode) => refreshCompaniesFlow(ui, node)),
    ),
    vscode.commands.registerCommand(
      'navapi.discover',
      command((node?: ProfileNode) => discoverFlow(ui, node)),
    ),
    vscode.commands.registerCommand(
      'navapi.removeProfile',
      command((node: ProfileNode) => removeProfileFlow(ui, node)),
    ),
    vscode.commands.registerCommand(
      'navapi.openEntity',
      command((node: EntitySetNode) => openEntityFlow(node)),
    ),
    vscode.commands.registerCommand(
      'navapi.openEntityJson',
      command((node: EntitySetNode) => openEntityJsonFlow(node)),
    ),
    vscode.commands.registerCommand(
      'navapi.showSchema',
      command(async (node: EntitySetNode) => {
        await openJsonDocument(schemaDocument(node.routePath, node.entitySet));
      }),
    ),
    vscode.commands.registerCommand(
      'navapi.braider.open',
      command(async (node: BraiderEndpointNode) => {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `navapi: reading ${node.endpoint.code}…`,
          },
          () => BraiderPanel.show(node),
        );
      }),
    ),
    vscode.commands.registerCommand(
      'navapi.braider.openJson',
      command((node: BraiderEndpointNode) => braiderOpenJsonFlow(node)),
    ),
    vscode.commands.registerCommand(
      'navapi.braider.schema',
      command((node: BraiderEndpointNode) => braiderSchemaFlow(node)),
    ),
    vscode.commands.registerCommand(
      'navapi.braider.refresh',
      command(async () => {
        braider.markStale();
        await ui.refresh();
      }),
    ),
    vscode.commands.registerCommand(
      'navapi.braider.newEndpoint',
      command(() => braiderNewEndpointFlow(ui)),
    ),
  );
}

export function deactivate(): void {
  // nothing to clean up: no long-lived connections
}
