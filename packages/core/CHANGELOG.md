# @navapi/core

## 0.3.0

### Added

- **Azure CLI authentication.** `ProfileAuth`/`Credential` gained an `azureCli`
  variant that takes its token from `az account get-access-token`, so no app
  registration or client secret is needed. A credential can pin *which* az
  identity to use, which is what makes delegated admin (GDAP) and guest access
  to another tenant work predictably.
- **Published ODataV4 web services.** Discovery enumerates the ODataV4 service
  document alongside API routes and combines it with `$metadata`, so page and
  query web services get the same filtering, selection, sorting, counts, and
  paging as the standard APIs. CRUD works against writable pages, including
  composite keys. Company scope uses the immutable `Company(Id=<guid>)` form.
- **Credentials separated from tenant and environment.** A `Credential` is a
  named identity; a `TargetContext` is where a request goes; a profile is a
  saved name for one pointed at the other. Several profiles can share one
  credential and one stored secret. `createClientForSelector()` is the single
  resolution rule every face uses — naming a credential, tenant, or environment
  layers over a profile rather than replacing it, so reaching one more tenant
  means naming the tenant and nothing else.
- **Read-only profiles.** `ProfileConfig.readOnly` makes `create`, `update`,
  `deleteRecord`, `callAction`, and `batch` refuse — `batch` per sub-request, so
  a write cannot hide inside one. A guardrail against accidental or
  agent-hallucinated writes, explicitly not a security boundary.
- **Profile import/export** (`portability.ts`): a versioned exchange format that
  never contains a secret, so the file is safe to share or commit.
- **Named and composite record keys.** `RecordKey` accepts
  `{ Document_Type: 'Order', Line_No: 10 }` wherever a scalar id was taken.
- Host-neutral presentation models (`presentation.ts`) shared with the VS Code
  extension and the new web UI, so the two UIs render from one implementation.

### Fixed

- **Key values are percent-encoded** in record URLs. A reserved character in a
  key — `#` most damagingly — previously changed the request's structure before
  it reached Business Central.
- **Linux: a non-durable keyring is no longer treated as the OS keychain.**
  Without a desktop session, `@napi-rs/keyring` could silently accept a secret
  that did not survive, so navapi now detects that case and uses the file store.
- OData read failures include the attempted request URL.

## 0.2.0

- **Native Data Braider support** (`braider.ts`): `detectBraider` with graceful capability levels (read/write vs. config API), and `BraiderClient` over the existing `BcClient` — endpoint discovery, reads with Braider filters and 1-based paging, writes, live-or-inferred schema, and remote endpoint authoring. Double-encoded payloads (`jsonResult`/`filterJson`/`jsonInput`) are unwrapped here; exported pure helpers `parseJsonResult`/`encodeJsonInput`/`encodeFilterJson`/`parseBraiderFilterSpec`.
- `BcClient.create()` gained an optional `etag` (enables `If-Match: *` writes).

## 0.1.0-alpha.1

First public alpha. Everything the four faces share:

- OAuth client-credentials auth with token caching, refresh, and in-flight coalescing
- Route discovery via the runtime API's `apiRoutes` (with `api/routes` and `v2.0` fallbacks)
- Per-route `$metadata` ingestion and on-disk caching (entity sets, keys, properties, navigation properties, bound actions)
- Company resolution (name/displayName/GUID) with automatic `companies(<id>)/` URL scoping
- CRUD with transparent ETags: GET → `If-Match` → retry-once-on-412
- Server-driven pagination (`Prefer: odata.maxpagesize`) with `@odata.nextLink` continuation, `$count` totals, and `buildListUrl`
- Navigation property fetching, OData `$batch` (JSON batch, `{company}` substitution), bound actions
- Profiles in `~/.navapi`, secrets in the OS keychain (`@napi-rs/keyring`) with file fallback and auto-migration
