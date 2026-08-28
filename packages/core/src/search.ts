import type { CachedRouteMetadata, EntitySetInfo } from './types.js';

/** One entity set together with the route it lives on. */
export interface EntitySetMatch {
  route: string;
  entitySet: EntitySetInfo;
}

/**
 * Case-insensitive substring search over cached $metadata.
 *
 * Matches the entity set name and the entity type, because those are the two
 * names a developer has in hand: `customers` is the URL segment, while AL
 * source and error messages talk about `customerEntity`. A term containing a
 * dot is matched against the qualified type, so a name pasted out of AL or an
 * error message works too.
 *
 * An empty term matches everything, so callers can use one code path for
 * "search" and "list all".
 */
export function searchEntitySets(cached: CachedRouteMetadata[], term?: string): EntitySetMatch[] {
  const needle = term?.trim().toLowerCase();
  const matches: EntitySetMatch[] = [];
  for (const entry of cached) {
    for (const entitySet of entry.metadata.entitySets) {
      if (!needle || matchesEntitySet(entitySet, needle)) {
        matches.push({ route: entry.routePath, entitySet });
      }
    }
  }
  return matches;
}

function matchesEntitySet(entitySet: EntitySetInfo, needle: string): boolean {
  if (entitySet.name.toLowerCase().includes(needle)) return true;
  const entityType = entitySet.entityType.toLowerCase();
  // A bare term is matched against the unqualified type only. Nearly every
  // type sits under `Microsoft.NAV`, so matching the qualified name would let
  // "nav" — or "microsoft" — return the entire environment. A term carrying a
  // dot is a qualified name the caller pasted, so match it in full.
  if (needle.includes('.')) return entityType.includes(needle);
  return entityType.slice(entityType.lastIndexOf('.') + 1).includes(needle);
}
