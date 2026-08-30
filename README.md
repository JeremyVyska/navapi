# navapi

[![CI](https://github.com/JeremyVyska/navapi/actions/workflows/ci.yml/badge.svg)](https://github.com/JeremyVyska/navapi/actions/workflows/ci.yml)

> The Business Central API toolkit that doesn't make you cry. 🧭

**navapi** is a discovery-first toolkit for talking to Microsoft Dynamics 365 Business Central APIs — with five faces sharing one brain:

- 📚 **`@navapi/core`** — TypeScript library. Auth, HTTP, ETag handling, `$metadata` discovery, pagination, retries.
- 🖥️ **`navapi` CLI** — because typing beats clicking. Agent-friendly with stable `--json` output.
- 🧩 **`navapi-vscode`** — Profiles/Companies/Endpoint Browser in the sidebar, a records grid with a BC-style query builder, server-side sort/paging, FastTab detail panes, and right-click filtering. Registers the MCP server for **GitHub Copilot agent mode** out of the box. For humans who like buttons.
- 🤖 **`@navapi/mcp`** — Model Context Protocol server: 24 typed tools (incl. the full Data Braider set), so agents get discovery, CRUD, actions, `$batch`, paging, and Data Braider read/write/authoring without shelling out.
- 🌐 **`navapi ui` / `@navapi/ui`** — secure local web application for consultants and administrators: shared profiles, companies, endpoint discovery, schemas, and read-only record queries without requiring VS Code.

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
navapi ui                # open the local web application
```

> The bare `navapi` npm name is squatted by an empty placeholder — the CLI lives at `@navapi/cli`, but the command it installs is still `navapi`.

See [Install and run the navapi web UI](docs/ui.md) for profile setup, launch
options, headless operation, and the user-scoped Windows Start Menu installer.

On headless Linux or over SSH, navapi automatically falls back to `~/.navapi/secrets.json`
when no desktop keyring session is available. Set `NAVAPI_SECRET_BACKEND=file`
explicitly for predictable headless operation.

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
navapi get Customer --route ODataV4 --top 10  # published page/query web service
navapi post Customer --route ODataV4 --body customer.json
navapi patch SalesLine --route ODataV4 \
  --key '{"Document_Type":"Order","Document_No":"SO-1","Line_No":10000}' \
  --set Quantity=2
```

### No app registration: Azure CLI auth

If you are already signed in with `az login`, skip the app registration entirely. `--auth azureCli` gets its token from `az account get-access-token`, so there is no client ID and no secret to store:

```bash
az login --tenant $TENANT_ID --scope https://api.businesscentral.dynamics.com/.default

navapi profile add contoso-dev \
  --tenant $TENANT_ID \
  --environment Sandbox-UAT \
  --auth azureCli
```

The profile then works exactly like any other, in the CLI, the VS Code extension, and the MCP server. Client-credentials auth stays the default, and existing profiles are untouched.

Reaching a customer's tenant works as long as one of the identities `az` holds has access to it — through delegated admin (GDAP), a guest invite, or an account in that tenant.

A profile records which identity it was created with, so a later `az login` as somebody else can't change who it authenticates as. With one identity that happens without asking; with several, `profile add` asks on a terminal:

```bash
navapi profile az-accounts     # the identities az is signed in as
navapi profile add customer-x --tenant $CUSTOMER_TENANT --environment Production --auth azureCli
#   az is signed in as more than one identity:
#    0) do not pin — follow whichever identity az is signed in as
#    1) me@example.com — signed in now
#    2) me@other.com
#   Select identity [0-2]:
```

Pass `--az-account me@example.com` to skip the question, in scripts or when you already know. The VS Code profile form offers the same list as a dropdown.

An identity reaches a tenant in one of two ways, and they behave differently:

- **`az` holds an account in that tenant.** navapi selects it directly, whichever identity you are signed in as at the time.
- **Delegated admin (GDAP) or a guest invite.** No account exists in the tenant, and `az` can only do this as the identity it is *currently* signed in as. So a profile pinned to a different identity is refused rather than quietly authenticating as the wrong one.

If neither applies yet, sign that identity in for the tenant once — which turns it into the first case:

```bash
az login --tenant $CUSTOMER_TENANT --allow-no-subscriptions --scope https://api.businesscentral.dynamics.com/.default
```

`--allow-no-subscriptions` matters — a tenant that only has Business Central usually has no Azure subscription, and `az login` fails without it. navapi puts this exact command in the error when it hits that case, so there is nothing to look up.

**This authenticates as you.** An az-cli token is a *delegated* token: Business Central sees a user, not an application. That means:

- You need a BC license and a permission set in that environment. An app registration does not.
- What you can read and write can differ from what the same environment's app-registration profile can, including row-level permissions.
- Some tenants require admin consent for the Azure CLI's first-party app against the BC API before any of this works.

So it is the right choice for exploring an environment as yourself, and the wrong one for an unattended integration — use client credentials there.

### Read-only profiles

Mark a profile read-only and every write through it is refused — create, update,
delete, bound actions, and any write hiding inside a `$batch`:

```bash
navapi profile add contoso-prod --tenant $TENANT --environment Production --client-id $CLIENT_ID --read-only
```

The guard sits in `BcClient`, which every face goes through, so the CLI, MCP
server, VS Code extension, web UI, and Data Braider are all covered. `profile
list`, `secrets status`, the MCP `list_profiles` tool, and the VS Code profile
form all show the flag. Data Braider *reads* keep working: they are POSTs
because the filters travel in the body, and the guard keys off intent rather
than the HTTP verb.

**This is a guardrail against mistakes, not a security boundary.** It catches an
accidental or hallucinated write from an agent, and that is all it is for.
Anything that can edit `~/.navapi/profiles.json` can clear the flag, and the
credential itself stays write-capable — Business Central's OData API has no
read-only OAuth scope, so a bearer token good for writes is good for writes
whoever sends the request. For enforcement that holds regardless of which tool
sends it, give the app registration or user a **read-only Business Central
permission set** in the environment. That is a tenant admin task, and it is the
only thing that actually stops a write.

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

One repo, workspace monorepo (pnpm), five packages:

```
navapi/
├── packages/
│   ├── core/       → @navapi/core     library, zero UI assumptions
│   ├── cli/        → navapi           thin wrapper, TTY-aware output
│   ├── vscode/     → navapi-vscode    extension, thin wrapper
│   ├── mcp/        → @navapi/mcp      MCP server, thin wrapper
│   └── ui/         → @navapi/ui       secure local web application
├── docs/           (planned — docs site)
├── examples/       (planned)
└── .changeset/
```

**Design rule:** if it's not UI-specific, it belongs in `core`. The faces should be as thin as physically possible. A bug in auth is fixed in one place.

## Design principles

1. **Discovery over documentation.** Hit `$metadata`, cache it, autocomplete from it. Don't make users read Microsoft Learn to find the entity name.
2. **Agent-first output.** Every command supports `--json` with a stable, semver'd schema. `isTTY` detection means humans get pretty output and pipes get JSON automatically.
3. **ETags are not the user's problem.** `patch` and `delete` transparently GET-then-modify with `If-Match`. Concurrency safety by default.
4. **Profiles, not env vars.** Named profiles for every customer × environment combo. Secrets go to the **OS keychain** (Credential Manager / Keychain / libsecret via `@napi-rs/keyring`), with a file fallback on platforms without one — existing file secrets migrate to the keychain automatically on first use. `navapi secrets status` shows where every secret lives; `NAVAPI_CLIENT_SECRET` covers CI and `NAVAPI_SECRET_BACKEND=file` opts out. Profiles created with `--auth azureCli` have no secret to store at all.
5. **Batching is a first-class citizen.** `$batch` support from day one — bulk ops are where BC APIs get slow.
6. **Same brain, five faces.** Any capability added to `core` is available to the CLI, VS Code, MCP, and local web application.

## Published ODataV4 web services

navapi discovers published page and query web services alongside API routes. In the VS Code
Endpoint Browser they appear under **ODataV4**; the CLI and MCP use `route: "ODataV4"`.
Discovery reads the `/ODataV4/` service document and combines it with `/ODataV4/$metadata`, so
filtering, field selection, sorting, counts, and server-driven paging use the same query tooling as
API endpoints. Company scope uses the immutable `Company(Id=<guid>)` form.

The CLI, MCP server, and core library support create, update, and delete for writable published
pages. Use a scalar record ID for single-key services or a named key object for OData services with
composite keys. Query web services and non-editable pages remain read-only as enforced by Business
Central. ODataV4 actions and JSON `$batch` aren't supported yet.

The VS Code records browser intentionally remains read-only for both API and ODataV4 endpoints.

## Status

🚀 **0.2.0 — live.** All four faces are built and tested (180+ tests) against a mock BC server, with native Data Braider support and GitHub Copilot (MCP) integration in the VS Code extension. The extension is on the VS Code Marketplace; `@navapi/core`, `@navapi/cli`, and `@navapi/mcp` publish to npm at 0.2.0.

Roadmap:

- [x] Workspace scaffold + tooling (pnpm, tsup, changesets, vitest, biome)
- [x] `@navapi/core`: OAuth client credentials, HTTP client, ETag handling
- [x] `@navapi/core`: `$metadata` discovery + on-disk cache (routes enumerated via the runtime API's `apiRoutes`, with `/api/routes` and `v2.0` fallbacks)
- [x] Read-only discovery and browsing for published `/ODataV4` page/query web services
- [x] Read-only profiles: `--read-only` refuses every write (including writes inside a `$batch`) across all faces — a guardrail against accidental or agent-hallucinated writes, not a security boundary
- [x] `navapi` CLI: `profile`, `get`, `post`, `patch`, `delete`, `discover` (+ `routes`, `ls`, `companies`)
- [x] `@navapi/core`: `$batch` support (JSON batch, `{company}` substitution, atomicity groups)
- [x] `@navapi/core`: bound actions (`Microsoft.NAV.*`, namespace-qualified from cached metadata)
- [x] `@navapi/mcp`: MCP server exposing typed tools (24 tools incl. navigation, real pagination, and the Data Braider tool set; profiles shared with the CLI)
- [x] `navapi-vscode`: registers the MCP server for GitHub Copilot agent mode (VS Code 1.101+), scoped to the active profile
- [x] `navapi-vscode`: sidebar sections (Profiles / Companies / Endpoint Browser with live record counts), records grid (server-side sort + paging via `odata.maxpagesize`, query builder for `$filter`/`$select`/`$count`, copyable query URL, BC-style right-click filtering, FastTab detail panes with lazy-loaded navigations), profile add/edit form with Test Connection
- [x] OS-keychain secret backend (`@napi-rs/keyring`, layered over the file store with auto-migration; `navapi secrets status|migrate`; keychain binding ships inside the `.vsix`)
- [x] Native Data Braider support in core, CLI, MCP, and VS Code (discovery, parsed reads/writes, live schema on Braider 2.4+, remote endpoint authoring, VS Code section + guided endpoint creation, `braider_*` MCP tools)
- [x] Secure local `navapi ui` application with shared profiles, companies, endpoint discovery, schemas, read-only records, loopback session authentication, and a Windows bootstrap installer
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
