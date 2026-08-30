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

/**
 * Percent-encodes the *content* of a key, leaving OData's own delimiters to
 * the caller. Doubling an apostrophe is OData string escaping and says nothing
 * about URL structure — and these literals are interpolated straight into a
 * request path, where `#` truncates it at the fragment, `?` starts the query,
 * `/` invents a path segment, `&` and `+` corrupt anything downstream, and a
 * bare `%` breaks the server's own decode. `encodeURIComponent` leaves the
 * RFC 3986 sub-delims `!'()*` alone; `(`, `)` and `,` would close or split the
 * key predicate, so they go too. The apostrophe is the one exception: it stays
 * literal, because it is OData syntax here rather than content.
 */
function encodeKeyText(text: string): string {
  return encodeURIComponent(text).replace(
    /[!()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function formatKeyValue(value: ODataKeyValue): string {
  if (typeof value === 'string') {
    // A GUID's charset is URL-safe, and BC wants it bare rather than quoted.
    return isGuid(value) ? value : `'${encodeKeyText(value.replace(/'/g, "''"))}'`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError('OData record keys cannot contain non-finite numbers.');
  }
  // Numbers and booleans stringify to a URL-safe charset already.
  return String(value);
}

/**
 * Formats a scalar or named composite key for OData addressing. GUID-shaped
 * strings stay bare for BC compatibility; other strings are quoted, escaped,
 * and percent-encoded so that reserved characters cannot restructure the URL.
 */
export function formatKey(key: RecordKey): string {
  if (typeof key === 'string') return formatKeyValue(key);
  const entries = Object.entries(key);
  if (!entries.length) throw new TypeError('OData record key objects cannot be empty.');
  if (entries.some(([name]) => !name.trim())) {
    throw new TypeError('OData record key field names cannot be empty.');
  }
  // Field names come from $metadata and are identifiers in practice, so
  // encoding them is a no-op — but it is the same class of bug if one ever
  // carries a `,` or `=`, which would split the predicate.
  return entries
    .map(([name, value]) => `${encodeKeyText(name)}=${formatKeyValue(value)}`)
    .join(',');
}
