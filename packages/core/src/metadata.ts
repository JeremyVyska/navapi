import { XMLParser } from 'fast-xml-parser';
import { NavApiError } from './errors.js';
import type {
  EntitySetInfo,
  NavigationPropertyInfo,
  PropertyInfo,
  RouteMetadata,
} from './types.js';

const ARRAY_ELEMENTS = new Set([
  'Schema',
  'EntityType',
  'Property',
  'NavigationProperty',
  'EntitySet',
  'Action',
  'Function',
  'Parameter',
  'PropertyRef',
  'EnumType',
]);

/** Finds a child regardless of XML namespace prefix (`Edmx` vs `edmx:Edmx`). */
function child(node: Record<string, unknown> | undefined, localName: string): unknown {
  if (!node) return undefined;
  for (const key of Object.keys(node)) {
    if (key === localName || key.endsWith(`:${localName}`)) return node[key];
  }
  return undefined;
}

function asArray<T>(value: unknown): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? (value as T[]) : [value as T];
}

interface EntityTypeDef {
  keys: string[];
  properties: PropertyInfo[];
  navigationProperties: NavigationPropertyInfo[];
}

function shortTypeName(qualified: string): string {
  const inner = qualified.replace(/^Collection\((.*)\)$/, '$1');
  return inner.slice(inner.lastIndexOf('.') + 1);
}

/**
 * Parses an OData EDMX ($metadata) document into the entity-set catalog that
 * powers discovery: entity sets, keys, properties, navigation properties,
 * and bound actions.
 */
export function parseMetadata(edmx: string): RouteMetadata {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    isArray: (tagName, _jPath, _isLeaf, isAttribute) =>
      !isAttribute && ARRAY_ELEMENTS.has(tagName.split(':').pop() ?? tagName),
  });
  const doc = parser.parse(edmx) as Record<string, unknown>;
  const edmxRoot = child(doc, 'Edmx') as Record<string, unknown> | undefined;
  const dataServices = child(edmxRoot, 'DataServices') as Record<string, unknown> | undefined;
  const schemas = asArray<Record<string, unknown>>(child(dataServices, 'Schema'));
  if (!schemas.length) {
    throw new NavApiError('Not a valid $metadata document: no <Schema> elements found');
  }

  let namespace = '';
  const typesByName = new Map<string, EntityTypeDef>();
  const actionsByType = new Map<string, string[]>();
  const containers: Record<string, unknown>[] = [];

  for (const schema of schemas) {
    const schemaNs = typeof schema.Namespace === 'string' ? schema.Namespace : '';

    for (const et of asArray<Record<string, unknown>>(child(schema, 'EntityType'))) {
      const name = typeof et.Name === 'string' ? et.Name : undefined;
      if (!name) continue;
      const keyNode = child(et, 'Key') as Record<string, unknown> | undefined;
      const keys = asArray<Record<string, unknown>>(child(keyNode, 'PropertyRef'))
        .map((ref) => (typeof ref.Name === 'string' ? ref.Name : ''))
        .filter(Boolean);
      const properties: PropertyInfo[] = asArray<Record<string, unknown>>(child(et, 'Property'))
        .filter((p) => typeof p.Name === 'string')
        .map((p) => ({
          name: p.Name as string,
          type: typeof p.Type === 'string' ? p.Type : 'Edm.String',
          nullable: String(p.Nullable ?? 'true') !== 'false',
          maxLength:
            p.MaxLength !== undefined && Number.isFinite(Number(p.MaxLength))
              ? Number(p.MaxLength)
              : undefined,
        }));
      const navigationProperties: NavigationPropertyInfo[] = asArray<Record<string, unknown>>(
        child(et, 'NavigationProperty'),
      )
        .filter((p) => typeof p.Name === 'string' && typeof p.Type === 'string')
        .map((p) => ({ name: p.Name as string, type: p.Type as string }));
      const def: EntityTypeDef = { keys, properties, navigationProperties };
      typesByName.set(name, def);
      if (schemaNs) typesByName.set(`${schemaNs}.${name}`, def);
    }

    for (const action of asArray<Record<string, unknown>>(child(schema, 'Action'))) {
      const name = typeof action.Name === 'string' ? action.Name : undefined;
      if (!name || String(action.IsBound) !== 'true') continue;
      const params = asArray<Record<string, unknown>>(child(action, 'Parameter'));
      const binding = params[0];
      if (!binding || typeof binding.Type !== 'string') continue;
      const target = shortTypeName(binding.Type);
      const list = actionsByType.get(target) ?? [];
      list.push(name);
      actionsByType.set(target, list);
    }

    const container = child(schema, 'EntityContainer') as Record<string, unknown> | undefined;
    if (container) {
      containers.push(container);
      if (!namespace && schemaNs) namespace = schemaNs;
    }
  }

  if (!namespace) {
    const first = schemas[0];
    namespace = first && typeof first.Namespace === 'string' ? first.Namespace : '';
  }

  const entitySets: EntitySetInfo[] = [];
  for (const container of containers) {
    for (const es of asArray<Record<string, unknown>>(child(container, 'EntitySet'))) {
      const name = typeof es.Name === 'string' ? es.Name : undefined;
      const entityType = typeof es.EntityType === 'string' ? es.EntityType : undefined;
      if (!name || !entityType) continue;
      const typeDef = typesByName.get(entityType) ?? typesByName.get(shortTypeName(entityType));
      entitySets.push({
        name,
        entityType,
        keys: typeDef?.keys ?? [],
        properties: typeDef?.properties ?? [],
        navigationProperties: typeDef?.navigationProperties ?? [],
        actions: actionsByType.get(shortTypeName(entityType)) ?? [],
      });
    }
  }
  entitySets.sort((a, b) => a.name.localeCompare(b.name));

  return { namespace, entitySets };
}
