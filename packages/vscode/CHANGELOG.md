# Change Log

All notable changes to the **navapi** extension are documented here. This
project adheres to [Semantic Versioning](https://semver.org/).

## 0.1.0

First public release.

### Added

- **Data Braider section** — when [Data Braider](https://github.com/Spare-Brained-Community/SBI-DataBraider)
  is detected in the environment, a dedicated tree view lists its configured
  endpoints. Browse endpoint data in a records panel with Braider-native
  filters (BC filter syntax) and 1-based page navigation; flat output renders
  as a grid, hierarchy output as expandable child tables. "Show Endpoint
  Schema" surfaces the exact field names/types (live on Data Braider 2.4+,
  inferred from sampled data otherwise).
- **Guided "New Endpoint" flow** (Data Braider 2.4+) — author an endpoint
  remotely with searchable table and multi-select field pickers, so you never
  type table or field numbers by hand.
- **Platform-specific packages** — the extension now ships per-platform builds
  (Windows, macOS, and Linux on x64/arm64, plus Alpine), each bundling the
  correct native keychain binding. On any platform the secret store falls back
  to a file backend if the binding is unavailable.
- Extension icon for the Marketplace listing.

### Included from earlier development iterations

- **Profiles / Companies / Endpoint Browser** sidebar sections. A profile pins
  one Business Central environment; profiles, companies, and cached metadata
  are shared with the navapi CLI and MCP server.
- **Records grid** with a BC-style query builder ($filter with right-click
  "filter to this value", $select field picker, always-on $count showing
  "x of Y"), server-driven sort and paging via `odata.maxpagesize`, a copyable
  request URL, FastTab detail panes with lazy-loaded navigation properties, and
  an "Open as JSON" escape hatch.
- **Discovery** — one click ingests `$metadata` from every API route and caches
  it as a browsable route → entity-set tree, with last-known record counts as
  badges.
- **Profile add/edit** as a form with a Test Connection button.
- **OS-keychain secrets** via `@napi-rs/keyring` (Windows Credential Manager /
  macOS Keychain / libsecret), layered over a file store with automatic
  migration.

[0.1.0]: https://github.com/JeremyVyska/navapi
