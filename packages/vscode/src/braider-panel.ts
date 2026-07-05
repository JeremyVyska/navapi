import {
  BraiderClient,
  type BraiderFilter,
  type BraiderReadResult,
  createClientForProfile,
  detectBraider,
} from '@navapi/core';
import * as vscode from 'vscode';
import { braiderGrid } from './braider-view.js';
import { renderBraiderHtml } from './braider-webview.js';
import type { BraiderEndpointNode } from './tree.js';
import { getNonce } from './webview.js';

const DEFAULT_PAGE_SIZE = 50;

function extensionVersion(): string {
  const version = vscode.extensions.getExtension('jeremy-vyska.navapi-vscode')?.packageJSON
    ?.version;
  return typeof version === 'string' ? version : 'dev';
}

interface LoadMessage {
  type?: string;
  filters?: BraiderFilter[];
  pageStart?: number;
  pageSize?: number;
}

/**
 * One webview panel per profile × Braider endpoint: parsed records grid
 * (flat or hierarchy — the double-encoded jsonResult never reaches the
 * webview), Braider filter rows, 1-based page navigation bounded by the
 * top-level record count, and an as-JSON escape hatch.
 */
export class BraiderPanel {
  private static readonly open = new Map<string, BraiderPanel>();

  static async show(node: BraiderEndpointNode): Promise<void> {
    const key = `${node.profileName}/${node.endpoint.code}`;
    const existing = BraiderPanel.open.get(key);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const client = await createClientForProfile(node.profileName);
    const info = await detectBraider(client);
    if (!info) throw new Error('Data Braider is no longer detected for this profile.');
    const braider = new BraiderClient(client, info);
    const result = await braider.readEndpoint(node.endpoint.code, {
      pageSize: DEFAULT_PAGE_SIZE,
    });
    BraiderPanel.open.set(key, new BraiderPanel(key, node, braider, result));
  }

  private readonly panel: vscode.WebviewPanel;
  private result: BraiderReadResult;
  private filters: BraiderFilter[] = [];
  private error?: string;

  private constructor(
    key: string,
    private readonly node: BraiderEndpointNode,
    private readonly braider: BraiderClient,
    initial: BraiderReadResult,
  ) {
    this.result = initial;
    this.panel = vscode.window.createWebviewPanel(
      'navapiBraider',
      `⚡ ${node.endpoint.code} — ${node.profileName}`,
      vscode.ViewColumn.Active,
      { enableScripts: true },
    );
    this.panel.onDidDispose(() => BraiderPanel.open.delete(key));
    this.panel.webview.onDidReceiveMessage((msg: LoadMessage) => void this.onMessage(msg));
    this.render();
  }

  private async onMessage(msg: LoadMessage): Promise<void> {
    if (msg.type === 'openJson') {
      const doc = await vscode.workspace.openTextDocument({
        language: 'json',
        content: JSON.stringify(this.result.records, null, 2),
      });
      await vscode.window.showTextDocument(doc, { preview: true });
      return;
    }
    if (msg.type === 'load') {
      this.filters = msg.filters ?? [];
      try {
        this.result = await this.braider.readEndpoint(this.node.endpoint.code, {
          filters: this.filters,
          pageStart: msg.pageStart ?? 1,
          pageSize: msg.pageSize ?? DEFAULT_PAGE_SIZE,
        });
        this.error = undefined;
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
      }
      this.render();
    }
  }

  private render(): void {
    this.panel.webview.html = renderBraiderHtml(
      {
        title: `${this.node.endpoint.code} · ${this.node.profileName}`,
        code: this.node.endpoint.code,
        endpointType: this.node.endpoint.endpointType,
        outputJsonType: this.node.endpoint.outputJsonType,
        grid: braiderGrid(this.error ? [] : this.result.records),
        recordCount: this.error ? 0 : this.result.records.length,
        topLevelRecordCount: this.result.topLevelRecordCount,
        pageStart: this.result.pageStart ?? 1,
        pageSize: this.result.pageSize ?? DEFAULT_PAGE_SIZE,
        hasMore: this.result.hasMore,
        filters: this.filters,
        error: this.error,
        version: extensionVersion(),
      },
      getNonce(),
    );
  }
}
