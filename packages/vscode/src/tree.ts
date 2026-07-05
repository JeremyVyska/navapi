import path from 'node:path';
import {
  BraiderClient,
  type BraiderEndpoint,
  companyLabel,
  createClientForProfile,
  defaultConfigDir,
  detectBraider,
  type EntitySetInfo,
  findCompany,
  MetadataCache,
  ProfileStore,
} from '@navapi/core';
import * as vscode from 'vscode';
import { loadBraiderCache, saveBraiderCache } from './braider-cache.js';
import { braiderEndpointIcon, braiderEndpointItem } from './braider-view.js';
import { loadCompanies, saveCompanies } from './companies-cache.js';
import { loadCounts } from './counts-cache.js';
import { companyItem, entitySetItem, profileItem, routeItem, sortProfiles } from './model.js';

export interface ProfileNode {
  kind: 'profile';
  profileName: string;
}

export interface CompanyNode {
  kind: 'company';
  profileName: string;
  companyId: string;
  label: string;
  internalName: string;
  isDefault: boolean;
}

export interface RouteNode {
  kind: 'route';
  profileName: string;
  routePath: string;
}

export interface EntitySetNode {
  kind: 'entitySet';
  profileName: string;
  routePath: string;
  entitySet: EntitySetInfo;
  /** Last unfiltered $count seen for this entity set, if any. */
  lastCount?: number;
}

export interface BraiderEndpointNode {
  kind: 'braiderEndpoint';
  profileName: string;
  routePath: string;
  endpoint: BraiderEndpoint;
}

export interface HintNode {
  kind: 'hint';
  hintFor: 'discover' | 'companies' | 'noProfile' | 'braider';
  profileName?: string;
}

export type Node =
  | ProfileNode
  | CompanyNode
  | RouteNode
  | EntitySetNode
  | BraiderEndpointNode
  | HintNode;

function store(): ProfileStore {
  return new ProfileStore(defaultConfigDir());
}

function metadataCache(): MetadataCache {
  return new MetadataCache(path.join(defaultConfigDir(), 'cache'));
}

/** The profile the Companies and Endpoints sections follow. */
export async function activeProfileName(): Promise<string | undefined> {
  return (await store().load()).defaultProfile;
}

function hintItem(node: HintNode): vscode.TreeItem {
  if (node.hintFor === 'noProfile') {
    const item = new vscode.TreeItem('Add a profile to get started…');
    item.iconPath = new vscode.ThemeIcon('add');
    item.command = { command: 'navapi.addProfile', title: 'Add Profile' };
    item.contextValue = 'hint';
    return item;
  }
  if (node.hintFor === 'braider') {
    const item = new vscode.TreeItem('Data Braider not detected — refresh to re-check…');
    item.iconPath = new vscode.ThemeIcon('sync');
    item.command = { command: 'navapi.braider.refresh', title: 'Refresh Data Braider' };
    item.contextValue = 'hint';
    return item;
  }
  const discover = node.hintFor === 'discover';
  const item = new vscode.TreeItem(
    discover ? 'Run "Discover" to load endpoints…' : 'Retry loading companies…',
  );
  item.contextValue = 'hint';
  item.iconPath = new vscode.ThemeIcon(discover ? 'sync' : 'warning');
  item.command = discover
    ? {
        command: 'navapi.discover',
        title: 'Discover',
        arguments: [
          node.profileName
            ? ({ kind: 'profile', profileName: node.profileName } satisfies ProfileNode)
            : undefined,
        ],
      }
    : { command: 'navapi.refreshCompanies', title: 'Refresh Companies' };
  return item;
}

abstract class BaseProvider<T> implements vscode.TreeDataProvider<T> {
  private readonly changed = new vscode.EventEmitter<T | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  refresh(): void {
    this.changed.fire(undefined);
  }

  abstract getChildren(node?: T): Promise<T[]>;
  abstract getTreeItem(node: T): Promise<vscode.TreeItem> | vscode.TreeItem;
}

/** "Profiles" section — click a profile to make it active everywhere. */
export class ProfilesProvider extends BaseProvider<ProfileNode> {
  async getChildren(node?: ProfileNode): Promise<ProfileNode[]> {
    if (node) return [];
    const { profiles, defaultProfile } = await store().listAll();
    return sortProfiles(profiles, defaultProfile).map((p) => ({
      kind: 'profile',
      profileName: p.name,
    }));
  }

  async getTreeItem(node: ProfileNode): Promise<vscode.TreeItem> {
    const { profiles, defaultProfile } = await store().listAll();
    const profile = profiles.find((p) => p.name === node.profileName);
    const isActive = node.profileName === defaultProfile;
    const info = profile
      ? profileItem(profile, isActive)
      : { label: node.profileName, tooltip: node.profileName };
    const item = new vscode.TreeItem(info.label, vscode.TreeItemCollapsibleState.None);
    item.description = info.description;
    item.tooltip = `${info.tooltip}\nClick to make this the active profile.`;
    item.contextValue = 'profile';
    item.iconPath = new vscode.ThemeIcon(isActive ? 'star-full' : 'server-environment');
    item.command = { command: 'navapi.useProfile', title: 'Use Profile', arguments: [node] };
    return item;
  }
}

/** "Companies" section — the active profile's companies; click to set default. */
export class CompaniesProvider extends BaseProvider<CompanyNode | HintNode> {
  async getChildren(node?: CompanyNode | HintNode): Promise<(CompanyNode | HintNode)[]> {
    if (node) return [];
    const profileName = await activeProfileName();
    if (!profileName) return [{ kind: 'hint', hintFor: 'noProfile' }];

    let companies = await loadCompanies(profileName);
    if (!companies) {
      // First expand: fetch live and cache, so later sessions are offline.
      try {
        const client = await createClientForProfile(profileName);
        companies = await client.listCompanies();
        await saveCompanies(profileName, companies);
      } catch (err) {
        vscode.window.showErrorMessage(
          `navapi: could not load companies for ${profileName}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return [{ kind: 'hint', hintFor: 'companies', profileName }];
      }
    }
    const profile = await store()
      .get(profileName)
      .catch(() => undefined);
    const current = profile?.company ? findCompany(companies, profile.company) : undefined;
    return companies.map((c) => ({
      kind: 'company',
      profileName,
      companyId: String(c.id ?? ''),
      label: companyLabel(c),
      internalName: String(c.name ?? ''),
      isDefault: Boolean(current && c.id === current.id),
    }));
  }

  getTreeItem(node: CompanyNode | HintNode): vscode.TreeItem {
    if (node.kind === 'hint') return hintItem(node);
    const info = companyItem(
      { id: node.companyId, name: node.internalName, displayName: node.label },
      node.isDefault,
    );
    const item = new vscode.TreeItem(info.label, vscode.TreeItemCollapsibleState.None);
    item.description = info.description;
    item.tooltip = info.tooltip;
    item.contextValue = 'company';
    item.iconPath = new vscode.ThemeIcon(node.isDefault ? 'star-full' : 'building');
    item.command = { command: 'navapi.selectCompany', title: 'Use Company', arguments: [node] };
    return item;
  }
}

/**
 * "Data Braider" section — the active profile's configured Braider endpoints.
 * First expand fetches live and caches (configDir/braider); afterwards the
 * section renders offline until a refresh.
 */
export class BraiderProvider extends BaseProvider<BraiderEndpointNode | HintNode> {
  /** Forces the next getChildren to refetch instead of using the cache. */
  private stale = false;

  markStale(): void {
    this.stale = true;
  }

  async getChildren(
    node?: BraiderEndpointNode | HintNode,
  ): Promise<(BraiderEndpointNode | HintNode)[]> {
    if (node) return [];
    const profileName = await activeProfileName();
    if (!profileName) return [{ kind: 'hint', hintFor: 'noProfile' }];

    let cached = this.stale ? undefined : await loadBraiderCache(profileName);
    if (!cached) {
      this.stale = false;
      try {
        const client = await createClientForProfile(profileName);
        const info = await detectBraider(client);
        if (!info) return [{ kind: 'hint', hintFor: 'braider', profileName }];
        const endpoints = await new BraiderClient(client, info).listEndpoints();
        await saveBraiderCache(profileName, info, endpoints);
        cached = { fetchedAt: new Date().toISOString(), info, endpoints };
      } catch (err) {
        vscode.window.showErrorMessage(
          `navapi: could not load Data Braider endpoints for ${profileName}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return [{ kind: 'hint', hintFor: 'braider', profileName }];
      }
    }
    return cached.endpoints.map((endpoint) => ({
      kind: 'braiderEndpoint',
      profileName,
      routePath: cached.info.routePath,
      endpoint,
    }));
  }

  getTreeItem(node: BraiderEndpointNode | HintNode): vscode.TreeItem {
    if (node.kind === 'hint') return hintItem(node);
    const info = braiderEndpointItem(node.endpoint);
    const item = new vscode.TreeItem(info.label, vscode.TreeItemCollapsibleState.None);
    item.description = info.description;
    item.tooltip = info.tooltip;
    item.contextValue = 'braiderEndpoint';
    item.iconPath = new vscode.ThemeIcon(braiderEndpointIcon(node.endpoint.endpointType));
    item.command = {
      command: 'navapi.braider.open',
      title: 'Browse Endpoint Data',
      arguments: [node],
    };
    return item;
  }
}

/** "Endpoint Browser" section — the active profile's routes → entity sets. */
export class EndpointsProvider extends BaseProvider<RouteNode | EntitySetNode | HintNode> {
  async getChildren(
    node?: RouteNode | EntitySetNode | HintNode,
  ): Promise<(RouteNode | EntitySetNode | HintNode)[]> {
    if (!node) {
      const profileName = await activeProfileName();
      if (!profileName) return [{ kind: 'hint', hintFor: 'noProfile' }];
      const cached = await metadataCache().list(profileName);
      if (!cached.length) return [{ kind: 'hint', hintFor: 'discover', profileName }];
      return cached.map((c) => ({ kind: 'route', profileName, routePath: c.routePath }));
    }
    if (node.kind === 'route') {
      const [cached, counts] = await Promise.all([
        metadataCache().get(node.profileName, node.routePath),
        loadCounts(node.profileName),
      ]);
      return (cached?.metadata.entitySets ?? []).map((es) => ({
        kind: 'entitySet',
        profileName: node.profileName,
        routePath: node.routePath,
        entitySet: es,
        lastCount: counts[`${node.routePath}/${es.name}`]?.count,
      }));
    }
    return [];
  }

  async getTreeItem(node: RouteNode | EntitySetNode | HintNode): Promise<vscode.TreeItem> {
    if (node.kind === 'hint') return hintItem(node);
    if (node.kind === 'route') {
      const cached = await metadataCache().get(node.profileName, node.routePath);
      const item = new vscode.TreeItem(node.routePath, vscode.TreeItemCollapsibleState.Collapsed);
      if (cached) {
        const info = routeItem(cached);
        item.description = info.description;
        item.tooltip = info.tooltip;
      }
      item.contextValue = 'route';
      item.iconPath = new vscode.ThemeIcon('plug');
      return item;
    }
    const info = entitySetItem(node.entitySet, node.lastCount);
    const item = new vscode.TreeItem(info.label, vscode.TreeItemCollapsibleState.None);
    item.description = info.description;
    item.tooltip = info.tooltip;
    item.contextValue = 'entitySet';
    item.iconPath = new vscode.ThemeIcon('symbol-class');
    item.command = { command: 'navapi.openEntity', title: 'Browse Records', arguments: [node] };
    return item;
  }
}
