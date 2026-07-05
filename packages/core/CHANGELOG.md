# @navapi/core

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
