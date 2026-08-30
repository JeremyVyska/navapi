/**
 * How a credential proves who it is. A discriminated union rather than flat
 * fields, so a new method adds one variant instead of adding optional
 * properties to every credential that will never use them.
 */
export type Credential =
  | {
      name: string;
      type: 'clientSecret';
      /** App registration client ID. The secret itself lives in the secret store. */
      clientId: string;
    }
  | {
      name: string;
      type: 'azureCli';
      /**
       * Which az identity to authenticate as, as a username or account id.
       * Only needed when az holds more than one; otherwise az uses whichever
       * account it is currently signed in as.
       */
      account?: string;
    };

export type CredentialType = Credential['type'];

/**
 * Where a request goes: one Business Central environment, and optionally a
 * default company. Deliberately carries no credential — the same identity
 * often reaches many tenants and environments, and the same environment is
 * often reached by several identities.
 */
export interface TargetContext {
  /** Entra ID (Azure AD) tenant ID or domain. */
  tenantId: string;
  /** BC environment name, e.g. `Production` or `Sandbox-UAT`. */
  environment: string;
  /** Default company (display name, name, or GUID). Optional; can be passed per call. */
  company?: string;
  /** Override for the BC API host. Defaults to https://api.businesscentral.dynamics.com */
  baseUrl?: string;
}

/**
 * A saved name for "this credential, pointed at this target" — the
 * convenience layer over {@link Credential} + {@link TargetContext}, not the
 * only way to reach an environment. Every face can also take a credential and
 * a target directly, without saving anything.
 */
export interface ProfileConfig extends TargetContext {
  /** Profile name, e.g. `contoso-prod`. */
  name: string;
  /** Name of the {@link Credential} this profile authenticates with. */
  credential: string;
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
   *
   * Lives on the profile rather than the credential: it describes what you are
   * pointed at, not who you are.
   */
  readOnly?: boolean;
}

/** A profile with its credential resolved — what {@link BcClient} is built from. */
export interface ResolvedProfile extends ProfileConfig {
  resolvedCredential: Credential;
}

/**
 * A profile as it may appear on disk, across every shape navapi has written.
 *
 * - **v0** (published 0.2.0): `clientId` at the top level, meaning
 *   client-credentials.
 * - **v1** (merged but never published): an `auth` discriminated union.
 * - **v2** (current): a `credential` name pointing into the file's
 *   `credentials` map.
 *
 * {@link ProfileStore} migrates the older two on read. v1 never reached a
 * release, so it exists only on the machines of people who ran `main` between
 * PR #8 and the credential split.
 */
export type StoredProfile = Omit<ProfileConfig, 'credential'> & {
  credential?: string;
  /** v1: the auth union, before credentials became separate entities. */
  auth?: { type: 'clientSecret'; clientId: string } | { type: 'azureCli'; account?: string };
  /** v0: client-credentials profiles written before `auth` existed. */
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
