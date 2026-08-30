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

export type ODataKeyValue = string | number | boolean;
export type RecordKey = string | Record<string, ODataKeyValue>;

export function isGuid(value: string): boolean {
  return GUID_RE.test(value);
}

function formatKeyValue(value: ODataKeyValue): string {
  if (typeof value === 'string') {
    return isGuid(value) ? value : `'${value.replace(/'/g, "''")}'`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError('OData record keys cannot contain non-finite numbers.');
  }
  return String(value);
}

/**
 * Formats a scalar or named composite key for OData addressing. GUID-shaped
 * strings stay bare for BC compatibility; other strings are quoted and escaped.
 */
export function formatKey(key: RecordKey): string {
  if (typeof key === 'string') return formatKeyValue(key);
  const entries = Object.entries(key);
  if (!entries.length) throw new TypeError('OData record key objects cannot be empty.');
  if (entries.some(([name]) => !name.trim())) {
    throw new TypeError('OData record key field names cannot be empty.');
  }
  return entries.map(([name, value]) => `${name}=${formatKeyValue(value)}`).join(',');
}
