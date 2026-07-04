import type { ApiRoute } from './types.js';

function fromPath(path: string): ApiRoute {
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 3) {
    const [publisher, group, version] = segments as [string, string, string];
    return { path: segments.join('/'), publisher, group, version };
  }
  return { path: segments.join('/'), version: segments[segments.length - 1] ?? path };
}

/**
 * Parses the response of `GET <env>/api/routes`. Tolerates the shapes BC has
 * used over time: plain strings, `{ route }`, or `{ publisher, group, version }`.
 */
export function parseRoutesResponse(data: unknown): ApiRoute[] {
  const value =
    data && typeof data === 'object' && 'value' in data ? (data as { value: unknown }).value : data;
  if (!Array.isArray(value)) return [];
  const routes: ApiRoute[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      routes.push(fromPath(item));
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.route === 'string' && obj.route) {
      routes.push(fromPath(obj.route));
      continue;
    }
    const version = typeof obj.version === 'string' ? obj.version : undefined;
    if (!version) continue;
    const publisher =
      typeof obj.publisher === 'string' && obj.publisher ? obj.publisher : undefined;
    const group = typeof obj.group === 'string' && obj.group ? obj.group : undefined;
    const path = [publisher, group, version].filter(Boolean).join('/');
    routes.push({ path, publisher, group, version });
  }
  return routes;
}
