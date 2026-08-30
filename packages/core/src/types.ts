/**
 * How a profile authenticates. A discriminated union rather than flat fields,
 * so a new method adds one variant instead of adding optional properties to
 * every profile that will never use them.
 */
export type ProfileAuth =
  | {
      type: 'clientSecret';
      /** App registration client ID. The secret itself lives in the secret store. */
      clientId: string;
    }
  | {
      type: 'azureCli';
      /**
       * Which az identity to authenticate as, as a username or account id.
       * Only needed when az holds more than one; otherwise az uses whichever
       * account it is currently signed in as.
       */
      account?: string;
    };

/** A named profile pinned to exactly one Business Central environment. */
export interface ProfileConfig {
  /** Profile name, e.g. `contoso-prod`. */
  name: string;
  /** Entra ID (Azure AD) tenant ID or domain. */
  tenantId: string;
  /** How this profile authenticates. */
  auth: ProfileAuth;
  /** BC environment name, e.g. `Production` or `Sandbox-UAT`. */
  environment: string;
  /** Default company (display name, name, or GUID). Optional; can be passed per call. */
  company?: string;
  /** Override for the BC API host. Defaults to https://api.businesscentral.dynamics.com */
  baseUrl?: string;
  /**
   * Refuse every write through this profile: create, update, delete, bound
   * actions, and any write inside a `$batch`.
   *
   * A guardrail against an accidental or hallucinated write, not a security
   * boundary — it lives in navapi's own code, on the same machine, under the
   * same account. Anything that can edit `profiles.json` can clear it, and the
   * bearer token stays write-capable whoever sends the request. Real
   * enforcement is a read-only BC permission set on the app registration or
   * user.
   */
  readOnly?: boolean;
}

/**
 * A profile as it may appear on disk. Files written before `auth` existed
 * carry `clientId` at the top level; {@link ProfileStore} normalizes them on
 * read, so nothing above this layer sees the older shape.
 */
export type StoredProfile = Omit<ProfileConfig, 'auth'> & {
  auth?: ProfileAuth;
  /** Legacy: client-credentials profiles written before `auth`. */
  clientId?: string;
};

/** A record returned by a BC OData endpoint. */
export type BcRecord = Record<string, unknown> & {
  '@odata.etag'?: string;
  id?: string;
};

/** One discoverable endpoint group: an API route or published ODataV4 services. */
export interface ApiRoute {
  /** API route path, or `ODataV4` for published page/query web services. */
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

/** Parsed $metadata for one API route or the ODataV4 service catalog. */
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
