# @navapi/cli

## 0.3.0

### Added

- **`navapi ui`** — launches the secure local web application from `@navapi/ui`.
- **`navapi credential add|list|remove`** — credentials are now their own thing,
  reusable across profiles, and `profile add --credential <name>` points a
  profile at one. `profile add` still mints one for you when you pass
  `--client-id` or `--auth azureCli`, so the single-profile case is unchanged.
- **`navapi profile export|import`** — hand a colleague or a new machine your
  setup. Exports never contain secrets; imports refuse collisions
  (`--overwrite`, `--rename old=new`) and report which credentials still need a
  secret.
- **`--credential`, `--tenant`, `--environment`** on every command that reaches
  an environment, each layering over the active profile. `navapi get customers
  --tenant <other>` reuses the profile's credential and environment and points
  them somewhere else. Also `NAVAPI_CREDENTIAL`, `NAVAPI_TENANT`, and
  `NAVAPI_ENVIRONMENT`.
- **Azure CLI auth**: `profile add --auth azureCli`, `--az-account` to pin an
  identity, and `navapi profile az-accounts` to see what az is signed in as. The
  add flow offers the identities as a list rather than asking you to recall one.
- **`--read-only`** on `profile add`, with an `access` column in `profile list`
  and `secrets status`.
- **`--key <json|file|->`** on `get`, `patch`, and `delete` for named and
  composite OData keys.
- ODataV4 published web services are discoverable and usable through the same
  commands (`--route ODataV4`).

### Changed

- `secrets status` reports one row per **credential** and the profiles it backs,
  since a shared credential is one secret rather than several.

## 0.2.0

- **`navapi braider`** command tree for Data Braider: `status`, `ls`, `get` (with a `Table.Field=filter` DSL, paging, `--all`, `--diagnostics`, `--raw`), `write`, `schema`, `tables`/`fields` lookups, and `config ls|get|create|update|delete` for remote endpoint authoring. Reads return clean parsed records; `--json` stays a stable bare array.

## 0.1.0-alpha.1

First public alpha. Installs the `navapi` command:

- `profile add|list|use|remove|test` — environment-pinned profiles with connection testing
- `company list|use` — switch the default company (interactive picker on a TTY)
- `discover`, `routes`, `ls` — enumerate API routes, ingest `$metadata`, browse the cached collection tree
- `get` (with `--filter/--select/--orderby/--top/--all/--count/--nav/--show-url`), `post`, `patch`, `delete` — ETags handled automatically
- `action` — bound actions, namespace-qualified from cached metadata
- `batch` — OData `$batch` with `{company}` substitution and per-request results
- `secrets status|migrate` — see where secrets live; move plaintext into the OS keychain
- TTY-aware output: humans get tables, pipes get stable JSON
