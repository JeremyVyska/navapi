# @navapi/cli

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
