# navapi

[![CI](https://github.com/JeremyVyska/navapi/actions/workflows/ci.yml/badge.svg)](https://github.com/JeremyVyska/navapi/actions/workflows/ci.yml)

> The Business Central API toolkit that doesn't make you cry. 🧭

**navapi** is a discovery-first toolkit for talking to Microsoft Dynamics 365 Business Central APIs — with four faces sharing one brain:

- 📚 **`@navapi/core`** — TypeScript library. Auth, HTTP, ETag handling, `$metadata` discovery, pagination, retries.
- 🖥️ **`navapi` CLI** — because typing beats clicking. Agent-friendly with stable `--json` output.
- 🧩 **`navapi-vscode`** — Profiles/Companies/Endpoint Browser in the sidebar, a records grid with a BC-style query builder, server-side sort/paging, FastTab detail panes, and right-click filtering. Registers the MCP server for **GitHub Copilot agent mode** out of the box. For humans who like buttons.
- 🤖 **`@navapi/mcp`** — Model Context Protocol server: 24 typed tools (incl. the full Data Braider set), so agents get discovery, CRUD, actions, `$batch`, paging, and Data Braider read/write/authoring without shelling out.

> "NAV lives. Now with better verbs."

---

## Why this exists

If you've ever spent 40 minutes re-configuring a Postman collection for the fourth customer this month — populating environments, refreshing tokens, remembering which company GUID goes where, hunting through the OData `$metadata` XML to figure out which custom API page a partner exposed — this is for you.

Postman is a great HTTP client. It is *not* a great **Business Central** client. navapi knows about companies, environments, ETags, bound actions, `$batch`, and the `$metadata` document. You should not have to.

## Install

```bash
npm i -g @navapi/cli     # the `navapi` command
npm i @navapi/core       # the library
npm i -g @navapi/mcp     # the MCP server (`navapi-mcp`)
```

> The bare `navapi` npm name is squatted by an empty placeholder — the CLI lives at `@navapi/cli`, but the command it installs is still `navapi`.

## What it looks like

```bash
# One-time setup per environment
navapi profile add contoso-prod \
  --tenant $TENANT_ID \
  --client-id $CLIENT_ID \
  --environment Production \
  --company "CRONUS International"

# Then just… use it
navapi profile test                # verify credentials before anything else
navapi company use                 # interactive picker; companies(<id>)/ prefixing is automatic
navapi get customers --top 10
navapi get customers --count --show-url            # "x of Y" totals + the exact request URL
navapi get salesOrders --filter "status eq 'Open'" --json | jq '.[] | .number'
navapi get salesOrders <id> --nav salesOrderLines  # navigation properties, no $expand wrangling
navapi patch customers 01121212-a0b0-e011-8fb2-78e7d1625bd8 --set blocked=All
navapi action salesOrders <id> shipAndInvoice      # bound actions, namespace-qualified for you
navapi batch --body bulk.json      # OData $batch with {company} substitution
navapi discover                    # every route + entity on this env, cached
navapi discover customer --schema  # show the shape
```

Or from an agent, via MCP:

```jsonc
// Agent asks for "release all sales orders over $10k from ACME"
// MCP exposes 24 typed tools: list_entities, get_entity_schema, get_records,
// get_next_page, get_navigation, update_record, invoke_action, invoke_batch,
// braider_read, braider_write, braider_create_endpoint, …
// No shell, no scraping stdout, just typed calls — with real pagination.
```

## Data Braider, natively

[Data Braider](https://github.com/Spare-Brained-Community/SBI-DataBraider) is the no-code API factory for BC: endpoints are configuration records, not AL code. navapi speaks its dialect natively — the double-encoded `jsonResult`/`filterJson`/`jsonInput` payloads, the `[{table, field, filter}]` BC-syntax filters, the 1-based page indexes — so you never see the plumbing:

```bash
navapi braider status                                    # detected? which capability level?
navapi braider ls                                        # configured endpoints
navapi braider get CUSTOMERS --filter "Customer.No.=10000..20000" --all
navapi braider write CUST_W --body records.json --action Upsert
navapi braider schema CUSTOMERS                          # exact field names + types
# Braider 2.4+ adds a config API — author endpoints remotely:
navapi braider tables Sales                              # find table numbers
navapi braider config create --body endpoint-spec.json   # header + lines + fields in one go
```

The VS Code extension grows a **Data Braider** section (endpoint browser with Braider-native filters/paging, plus a guided "New Endpoint" flow with table/field pickers), and MCP agents get `braider_*` tools with the write conventions documented in the tool descriptions. On older Braider installs everything except schema/authoring still works — schemas fall back to inference from sampled data.

## Architecture

One repo, workspace monorepo (pnpm), four packages:

```
navapi/
├── packages/
│   ├── core/       → @navapi/core     library, zero UI assumptions
│   ├── cli/        → navapi           thin wrapper, TTY-aware output
│   ├── vscode/     → navapi-vscode    extension, thin wrapper
│   └── mcp/        → @navapi/mcp      MCP server, thin wrapper
├── docs/           (planned — docs site)
├── examples/       (planned)
└── .changeset/
```

**Design rule:** if it's not UI-specific, it belongs in `core`. The faces should be as thin as physically possible. A bug in auth is fixed in one place.

## Design principles

1. **Discovery over documentation.** Hit `$metadata`, cache it, autocomplete from it. Don't make users read Microsoft Learn to find the entity name.
2. **Agent-first output.** Every command supports `--json` with a stable, semver'd schema. `isTTY` detection means humans get pretty output and pipes get JSON automatically.
3. **ETags are not the user's problem.** `patch` and `delete` transparently GET-then-modify with `If-Match`. Concurrency safety by default.
4. **Profiles, not env vars.** Named profiles for every customer × environment combo. Secrets go to the **OS keychain** (Credential Manager / Keychain / libsecret via `@napi-rs/keyring`), with a file fallback on platforms without one — existing file secrets migrate to the keychain automatically on first use. `navapi secrets status` shows where every secret lives; `NAVAPI_CLIENT_SECRET` covers CI and `NAVAPI_SECRET_BACKEND=file` opts out.
5. **Batching is a first-class citizen.** `$batch` support from day one — bulk ops are where BC APIs get slow.
6. **Same brain, four faces.** Any capability added to `core` is instantly available to CLI, VS Code, and MCP.

## Status

🚀 **0.2.0 — live.** All four faces are built and tested (180+ tests) against a mock BC server, with native Data Braider support and GitHub Copilot (MCP) integration in the VS Code extension. The extension is on the VS Code Marketplace; `@navapi/core`, `@navapi/cli`, and `@navapi/mcp` publish to npm at 0.2.0.

Roadmap:

- [x] Workspace scaffold + tooling (pnpm, tsup, changesets, vitest, biome)
- [x] `@navapi/core`: OAuth client credentials, HTTP client, ETag handling
- [x] `@navapi/core`: `$metadata` discovery + on-disk cache (routes enumerated via the runtime API's `apiRoutes`, with `/api/routes` and `v2.0` fallbacks)
- [x] `navapi` CLI: `profile`, `get`, `post`, `patch`, `delete`, `discover` (+ `routes`, `ls`, `companies`)
- [x] `@navapi/core`: `$batch` support (JSON batch, `{company}` substitution, atomicity groups)
- [x] `@navapi/core`: bound actions (`Microsoft.NAV.*`, namespace-qualified from cached metadata)
- [x] `@navapi/mcp`: MCP server exposing typed tools (24 tools incl. navigation, real pagination, and the Data Braider tool set; profiles shared with the CLI)
- [x] `navapi-vscode`: registers the MCP server for GitHub Copilot agent mode (VS Code 1.101+), scoped to the active profile
- [x] `navapi-vscode`: sidebar sections (Profiles / Companies / Endpoint Browser with live record counts), records grid (server-side sort + paging via `odata.maxpagesize`, query builder for `$filter`/`$select`/`$count`, copyable query URL, BC-style right-click filtering, FastTab detail panes with lazy-loaded navigations), profile add/edit form with Test Connection
- [x] OS-keychain secret backend (`@napi-rs/keyring`, layered over the file store with auto-migration; `navapi secrets status|migrate`; keychain binding ships inside the `.vsix`)
- [x] Native Data Braider support across all four faces (discovery, parsed reads/writes, live schema on Braider 2.4+, remote endpoint authoring, VS Code section + guided endpoint creation, `braider_*` MCP tools)
- [ ] Docs site
- [x] `0.2.0` to npm + the VS Code Marketplace

## What Ifs

Answered by building:

- ✅ **What if BC returns a 412?** Auto-retry once with a fresh GET + `If-Match`, then surface the conflict. Implemented in core; all faces inherit it.
- ✅ **What if a bound action takes a complex parameter object?** `navapi action … --body <file|json|->` and the `parameters` argument on the MCP tool.
- ✅ **What if a profile's secret expires?** Client-credentials tokens auto-refresh (with in-flight coalescing); a bad secret surfaces the raw AADSTS error, and `navapi profile test` / the form's Test Connection catch it early.

Still open:

- **What if the user has 12 customers × 3 environments each?** Profile groups / tags for bulk operations across envs? (Later, not v1.)
- **What if this pattern works for D365 F&O too?** Name locks us to BC/NAV lineage. Fine for now, revisit at 1.0.
- **What if two agents hit the same record via MCP?** Session-scoped ETag cache to prevent stale reads within a conversation.

## Contributing

Not open for contributions yet — still shaping the core API. Star and watch if you want to be pinged when it's ready. 🌟

## License

MIT. See [LICENSE](LICENSE).

## Prior art & respect

- The name is a knowing wink to **Navision**, the Danish ERP that became NAV that became Business Central. If you got the joke, you're old. Same. 🧓
- Command surface inspired by `kubectl`, `aws`, and `gh` — because they got the human/agent duality right.
- MCP support because [Model Context Protocol](https://modelcontextprotocol.io) is the right primitive for agent tooling and shelling out to a CLI is a workaround, not a design.

---

*Made because Postman collections don't scale to 40 tenants.* ✨
