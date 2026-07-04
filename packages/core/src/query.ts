export interface ODataQuery {
  filter?: string;
  top?: number;
  skip?: number;
  select?: string[];
  expand?: string[];
  orderby?: string[];
  count?: boolean;
}

/**
 * Builds an OData query string (including the leading `?`), or an empty
 * string when there is nothing to add. Uses %20-style encoding since OData
 * services treat `+` in queries literally.
 */
export function buildQueryString(query?: ODataQuery): string {
  if (!query) return '';
  const parts: string[] = [];
  if (query.filter) parts.push(`$filter=${encodeURIComponent(query.filter)}`);
  if (query.select?.length) parts.push(`$select=${encodeURIComponent(query.select.join(','))}`);
  if (query.expand?.length) parts.push(`$expand=${encodeURIComponent(query.expand.join(','))}`);
  if (query.orderby?.length) parts.push(`$orderby=${encodeURIComponent(query.orderby.join(','))}`);
  if (query.top !== undefined) parts.push(`$top=${query.top}`);
  if (query.skip !== undefined) parts.push(`$skip=${query.skip}`);
  if (query.count) parts.push('$count=true');
  return parts.length ? `?${parts.join('&')}` : '';
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isGuid(value: string): boolean {
  return GUID_RE.test(value);
}

/** Formats a single key for OData addressing: GUIDs bare, everything else quoted. */
export function formatKey(id: string): string {
  return isGuid(id) ? id : `'${id.replace(/'/g, "''")}'`;
}
