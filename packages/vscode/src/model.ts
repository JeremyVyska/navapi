/**
 * Pure presentation logic for the tree view — no vscode imports, so it can
 * be unit-tested without an extension host.
 */
import type { CachedRouteMetadata, EntitySetInfo, ProfileConfig } from '@navapi/core';

export interface ItemPresentation {
  label: string;
  description?: string;
  tooltip: string;
}

export function profileItem(profile: ProfileConfig, isDefault: boolean): ItemPresentation {
  const scope = [profile.environment, profile.company].filter(Boolean).join(' · ');
  return {
    label: profile.name,
    description: `${scope}${isDefault ? ' • default' : ''}`,
    tooltip: [
      `Profile: ${profile.name}${isDefault ? ' (default)' : ''}`,
      `Environment: ${profile.environment}`,
      `Tenant: ${profile.tenantId}`,
      profile.company ? `Company: ${profile.company}` : 'Company: (not set)',
    ].join('\n'),
  };
}

export function routeItem(route: CachedRouteMetadata): ItemPresentation {
  const count = route.metadata.entitySets.length;
  return {
    label: route.routePath,
    description: `${count} ${count === 1 ? 'entity set' : 'entity sets'}`,
    tooltip: `Route ${route.routePath}\nNamespace: ${route.metadata.namespace}\nMetadata fetched: ${route.fetchedAt}`,
  };
}

export function entitySetItem(es: EntitySetInfo, lastCount?: number): ItemPresentation {
  const parts: string[] = [];
  if (lastCount !== undefined) parts.push(lastCount.toLocaleString('en-US'));
  if (es.actions.length) parts.push(`⚡${es.actions.length}`);
  return {
    label: es.name,
    description: parts.join(' · ') || undefined,
    tooltip: [
      `${es.name} (${es.entityType})`,
      lastCount !== undefined
        ? `Last known count: ${lastCount.toLocaleString('en-US')}`
        : undefined,
      `Keys: ${es.keys.join(', ') || '(none)'}`,
      `Properties: ${es.properties.length}`,
      es.navigationProperties.length
        ? `Navigation: ${es.navigationProperties.map((n) => n.name).join(', ')}`
        : undefined,
      es.actions.length ? `Bound actions: ${es.actions.join(', ')}` : undefined,
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

export function companyItem(
  company: { id?: unknown; name?: unknown; displayName?: unknown },
  isDefault: boolean,
): ItemPresentation {
  const label = String(company.displayName ?? company.name ?? company.id ?? '(unnamed)');
  const internalName = String(company.name ?? '');
  return {
    label,
    description: `${internalName}${isDefault ? ' • default' : ''}`.trim() || undefined,
    tooltip: [
      label,
      internalName ? `Name: ${internalName}` : undefined,
      company.id ? `Id: ${company.id}` : undefined,
      isDefault ? 'Default company for this profile' : 'Click to make this the default company',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

/** Schema document shown by "Show Schema" — stable shape, pretty-printed JSON. */
export function schemaDocument(routePath: string, es: EntitySetInfo): string {
  return JSON.stringify(
    {
      entitySet: es.name,
      entityType: es.entityType,
      route: routePath,
      keys: es.keys,
      boundActions: es.actions,
      properties: es.properties,
      navigationProperties: es.navigationProperties,
    },
    null,
    2,
  );
}

/** Sorts profiles with the default first, then alphabetically. */
export function sortProfiles(profiles: ProfileConfig[], defaultProfile?: string): ProfileConfig[] {
  return [...profiles].sort((a, b) => {
    if (a.name === defaultProfile) return -1;
    if (b.name === defaultProfile) return 1;
    return a.name.localeCompare(b.name);
  });
}
