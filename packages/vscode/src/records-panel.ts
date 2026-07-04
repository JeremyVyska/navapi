import { type BcClient, type BcRecord, createClientForProfile } from '@navapi/core';
import * as vscode from 'vscode';
import { saveCount } from './counts-cache.js';
import { buildFilterExpression, type FilterRow, operatorsFor } from './filter.js';
import { buildGrid, recordGrid } from './grid.js';
import type { EntitySetNode } from './tree.js';
import { getNonce, type RecordsViewState, renderRecordsHtml } from './webview.js';

const PAGE_TOP = 50;

function extensionVersion(): string {
  const version = vscode.extensions.getExtension('jeremy-vyska.navapi-vscode')?.packageJSON
    ?.version;
  return typeof version === 'string' ? version : 'dev';
}

interface PanelMessage {
  type?: string;
  rows?: FilterRow[];
  combinator?: 'and' | 'or';
  manual?: string;
  select?: string[];
  rowIndex?: number;
  nav?: string;
  field?: string;
  dir?: 'asc' | 'desc';
  text?: string;
}

interface OrderBy {
  field: string;
  dir: 'asc' | 'desc';
}

interface QueryResult {
  records: BcRecord[];
  nextLink?: string;
  totalCount?: number;
  queryUrl: string;
}

/**
 * One webview panel per profile × route × entity set: sortable grid with
 * expandable sub-tables, a schema-driven OData query builder ($filter +
 * $select + $count), a FastTab-style detail pane that lazy-loads navigation
 * properties, "Load more" paging, a copyable query URL, and an as-JSON
 * escape hatch. Panels are reused on repeat clicks.
 */
export class RecordsPanel {
  private static readonly open = new Map<string, RecordsPanel>();

  static async show(node: EntitySetNode, onCountKnown?: () => void): Promise<void> {
    const key = `${node.profileName}/${node.routePath}/${node.entitySet.name}`;
    const existing = RecordsPanel.open.get(key);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const client = await createClientForProfile(node.profileName);
    const initial = await RecordsPanel.runQuery(client, node, undefined, undefined);
    RecordsPanel.open.set(key, new RecordsPanel(key, node, client, initial, onCountKnown));
  }

  /** One first-page fetch with $count, plus the URL it used. Keys are always
   * kept in $select so rows stay addressable for navigations. */
  private static async runQuery(
    client: BcClient,
    node: EntitySetNode,
    filter: string | undefined,
    select: string[] | undefined,
    orderby?: OrderBy,
  ): Promise<QueryResult> {
    let effectiveSelect: string[] | undefined;
    if (select?.length) {
      const keys = node.entitySet.keys.length ? node.entitySet.keys : ['id'];
      effectiveSelect = [...new Set([...keys, ...select])];
    }
    // Server-driven paging (Prefer: odata.maxpagesize), NOT $top — $top caps
    // the result set and never yields an @odata.nextLink, which made partial
    // datasets look complete (and made "sort" quietly sort only page one).
    const opts = {
      route: node.routePath,
      maxPageSize: PAGE_TOP,
      query: {
        count: true,
        filter: filter || undefined,
        select: effectiveSelect,
        orderby: orderby ? [`${orderby.field} ${orderby.dir}`] : undefined,
      },
    };
    const [{ items, nextLink, count }, queryUrl] = await Promise.all([
      client.list(node.entitySet.name, opts),
      client.buildListUrl(node.entitySet.name, opts),
    ]);
    return { records: items, nextLink, totalCount: count, queryUrl };
  }

  private readonly panel: vscode.WebviewPanel;
  private records: BcRecord[];
  private nextLink?: string;
  private totalCount?: number;
  private queryUrl: string;
  private filter?: string;
  private select?: string[];
  private orderby?: OrderBy;

  private constructor(
    key: string,
    private readonly node: EntitySetNode,
    private readonly client: BcClient,
    initial: QueryResult,
    private readonly onCountKnown?: () => void,
  ) {
    this.records = initial.records;
    this.nextLink = initial.nextLink;
    this.totalCount = initial.totalCount;
    this.queryUrl = initial.queryUrl;
    this.panel = vscode.window.createWebviewPanel(
      'navapiRecords',
      `${node.entitySet.name} — ${node.profileName}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.webview.html = renderRecordsHtml(this.state(), getNonce());
    this.panel.webview.onDidReceiveMessage((msg: PanelMessage) => {
      if (msg?.type === 'openJson') void this.openJson();
      if (msg?.type === 'loadMore') void this.loadMore();
      if (msg?.type === 'previewFilter') void this.previewFilter(msg);
      if (msg?.type === 'applyQuery') void this.applyQuery(msg);
      if (msg?.type === 'copyUrl') void this.copyUrl();
      if (msg?.type === 'copyValue') void this.copyValue(msg.text ?? '');
      if (msg?.type === 'fetchNav') void this.fetchNav(msg);
      if (msg?.type === 'sortBy') void this.sortBy(msg);
    });
    this.panel.onDidDispose(() => RecordsPanel.open.delete(key));
    void this.persistCount();
  }

  /** Remember unfiltered totals so the tree can show last-known counts. */
  private async persistCount(): Promise<void> {
    if (this.filter || this.totalCount === undefined) return;
    await saveCount(
      this.node.profileName,
      this.node.routePath,
      this.node.entitySet.name,
      this.totalCount,
    );
    this.onCountKnown?.();
  }

  /** More data exists if the server said so (nextLink) OR the $count total
   * proves our page is partial (covers servers that ignore maxpagesize). */
  private hasMore(): boolean {
    return (
      Boolean(this.nextLink) ||
      (this.totalCount !== undefined && this.records.length < this.totalCount)
    );
  }

  private state(): RecordsViewState {
    return {
      title: `${this.node.entitySet.name}  ·  ${this.node.routePath}  ·  ${this.node.profileName}`,
      grid: buildGrid(this.records),
      count: this.records.length,
      totalCount: this.totalCount,
      hasMore: this.hasMore(),
      fields: this.node.entitySet.properties.map((p) => ({
        name: p.name,
        type: p.type,
        ops: operatorsFor(p.type),
      })),
      navProps: this.node.entitySet.navigationProperties.map((n) => n.name),
      filter: this.filter ?? '',
      select: this.select ?? [],
      orderby: this.orderby ?? null,
      queryUrl: this.queryUrl,
      version: extensionVersion(),
    };
  }

  private async openJson(): Promise<void> {
    const doc = await vscode.workspace.openTextDocument({
      language: 'json',
      content: JSON.stringify(this.records, null, 2),
    });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  private async copyUrl(): Promise<void> {
    await vscode.env.clipboard.writeText(this.queryUrl);
    vscode.window.setStatusBarMessage('navapi: query URL copied', 4000);
  }

  private async copyValue(text: string): Promise<void> {
    await vscode.env.clipboard.writeText(text);
    vscode.window.setStatusBarMessage('navapi: value copied', 4000);
  }

  private async previewFilter(msg: PanelMessage): Promise<void> {
    await this.panel.webview.postMessage({
      type: 'filterPreview',
      text: buildFilterExpression(msg.rows ?? [], msg.combinator ?? 'and'),
    });
  }

  /** Applies $filter/$select server-side by refetching the first page. */
  private async applyQuery(msg: PanelMessage): Promise<void> {
    const expression =
      msg.manual?.trim() ?? buildFilterExpression(msg.rows ?? [], msg.combinator ?? 'and');
    const select = msg.select?.length ? msg.select : undefined;
    try {
      const result = await RecordsPanel.runQuery(
        this.client,
        this.node,
        expression || undefined,
        select,
        this.orderby,
      );
      this.filter = expression || undefined;
      this.select = select;
      this.records = result.records;
      this.nextLink = result.nextLink;
      this.totalCount = result.totalCount;
      this.queryUrl = result.queryUrl;
      await this.panel.webview.postMessage({ type: 'state', state: this.state() });
      await this.persistCount();
    } catch (err) {
      await this.panel.webview.postMessage({
        type: 'filterError',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Server-side $orderby: refetches page 1 in the requested order. */
  private async sortBy(msg: PanelMessage): Promise<void> {
    if (!msg.field) return;
    const orderby: OrderBy = { field: msg.field, dir: msg.dir === 'desc' ? 'desc' : 'asc' };
    try {
      const result = await RecordsPanel.runQuery(
        this.client,
        this.node,
        this.filter,
        this.select,
        orderby,
      );
      this.orderby = orderby;
      this.records = result.records;
      this.nextLink = result.nextLink;
      this.totalCount = result.totalCount;
      this.queryUrl = result.queryUrl;
      await this.panel.webview.postMessage({ type: 'state', state: this.state() });
    } catch (err) {
      await this.panel.webview.postMessage({
        type: 'filterError',
        message: err instanceof Error ? err.message : String(err),
      });
      vscode.window.showErrorMessage(`navapi: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Lazy FastTab load: one navigation property of one record. */
  private async fetchNav(msg: PanelMessage): Promise<void> {
    const rowIndex = msg.rowIndex ?? -1;
    const nav = msg.nav ?? '';
    const record = this.records[rowIndex];
    try {
      const id = typeof record?.id === 'string' ? record.id : undefined;
      if (!id) throw new Error('Record has no id field, so navigations cannot be addressed.');
      const result = await this.client.getNavigation(this.node.entitySet.name, id, nav, {
        route: this.node.routePath,
      });
      await this.panel.webview.postMessage({
        type: 'navResult',
        rowIndex,
        nav,
        kind: result.kind,
        count: result.kind === 'collection' ? result.items.length : undefined,
        grid:
          result.kind === 'collection'
            ? buildGrid(result.items)
            : recordGrid(result.items[0] ?? {}),
      });
    } catch (err) {
      await this.panel.webview.postMessage({
        type: 'navError',
        rowIndex,
        nav,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async loadMore(): Promise<void> {
    if (!this.hasMore()) return;
    try {
      if (this.nextLink) {
        const page = await this.client.followNextLink(this.nextLink, { maxPageSize: PAGE_TOP });
        this.records = [...this.records, ...page.items];
        this.nextLink = page.nextLink;
      } else {
        // No nextLink but the count says there is more: $skip continuation.
        const page = await this.client.list(this.node.entitySet.name, {
          route: this.node.routePath,
          maxPageSize: PAGE_TOP,
          query: {
            filter: this.filter,
            select: this.select?.length ? this.select : undefined,
            orderby: this.orderby ? [`${this.orderby.field} ${this.orderby.dir}`] : undefined,
            skip: this.records.length,
          },
        });
        this.records = [...this.records, ...page.items];
        this.nextLink = page.nextLink;
      }
    } catch (err) {
      vscode.window.showErrorMessage(`navapi: ${err instanceof Error ? err.message : String(err)}`);
    }
    await this.panel.webview.postMessage({ type: 'state', state: this.state() });
  }
}
