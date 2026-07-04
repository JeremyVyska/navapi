/** A named profile pinned to exactly one Business Central environment. */
export interface ProfileConfig {
  /** Profile name, e.g. `contoso-prod`. */
  name: string;
  /** Entra ID (Azure AD) tenant ID or domain. */
  tenantId: string;
  /** App registration client ID used for client-credentials auth. */
  clientId: string;
  /** BC environment name, e.g. `Production` or `Sandbox-UAT`. */
  environment: string;
  /** Default company (display name, name, or GUID). Optional; can be passed per call. */
  company?: string;
  /** Override for the BC API host. Defaults to https://api.businesscentral.dynamics.com */
  baseUrl?: string;
}

/** A record returned by a BC OData endpoint. */
export type BcRecord = Record<string, unknown> & {
  '@odata.etag'?: string;
  id?: string;
};

/** One API route exposed by the environment (from GET /api/routes). */
export interface ApiRoute {
  /** Route path relative to `<env>/api/`, e.g. `v2.0` or `contoso/fieldops/v1.0`. */
  path: string;
  publisher?: string;
  group?: string;
  version: string;
}

export interface PropertyInfo {
  name: string;
  type: string;
  nullable: boolean;
  maxLength?: number;
}

export interface NavigationPropertyInfo {
  name: string;
  type: string;
}

export interface EntitySetInfo {
  /** The URL segment, e.g. `customers`. */
  name: string;
  /** Fully qualified entity type, e.g. `Microsoft.NAV.customer`. */
  entityType: string;
  keys: string[];
  properties: PropertyInfo[];
  navigationProperties: NavigationPropertyInfo[];
  /** Bound action names available on this entity, e.g. `Microsoft.NAV.shipAndInvoice`. */
  actions: string[];
}

/** Parsed $metadata for one API route. */
export interface RouteMetadata {
  namespace: string;
  entitySets: EntitySetInfo[];
}

/** RouteMetadata plus cache bookkeeping. */
export interface CachedRouteMetadata {
  routePath: string;
  fetchedAt: string;
  metadata: RouteMetadata;
}

export interface RouteDiscoveryResult {
  route: ApiRoute;
  metadata?: CachedRouteMetadata;
  error?: string;
}
