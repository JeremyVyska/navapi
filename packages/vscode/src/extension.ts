import {
  createClientForProfile,
  defaultConfigDir,
  FileSecretStore,
  ProfileStore,
} from '@navapi/core';
import * as vscode from 'vscode';
import { saveCompanies } from './companies-cache.js';
import { schemaDocument } from './model.js';
import { ProfileFormPanel } from './profile-form.js';
import { RecordsPanel } from './records-panel.js';
import {
  activeProfileName,
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
  const hasSecret = Boolean(await new FileSecretStore(dir).get(node.profileName));
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

async function removeProfileFlow(ui: Ui, node: ProfileNode): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    `Remove profile "${node.profileName}" (including its stored secret and metadata cache)?`,
    { modal: true },
    'Remove',
  );
  if (confirm !== 'Remove') return;
  const dir = defaultConfigDir();
  await new ProfileStore(dir).remove(node.profileName);
  await new FileSecretStore(dir).delete(node.profileName);
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

  const profilesView = vscode.window.createTreeView('navapi.profiles', {
    treeDataProvider: profiles,
  });
  const companiesView = vscode.window.createTreeView('navapi.companies', {
    treeDataProvider: companies,
  });
  const endpointsView = vscode.window.createTreeView('navapi.endpoints', {
    treeDataProvider: endpoints,
  });

  const ui: Ui = {
    async refresh() {
      profiles.refresh();
      companies.refresh();
      endpoints.refresh();
      const active = await activeProfileName();
      companiesView.description = active ?? '';
      endpointsView.description = active ?? '';
    },
  };
  void ui.refresh();

  context.subscriptions.push(
    profilesView,
    companiesView,
    endpointsView,
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
  );
}

export function deactivate(): void {
  // nothing to clean up: no long-lived connections
}
