# @navapi/mcp

## 0.3.0

### Added

- **Credential and target arguments on every tool** (`credential`, `tenant`,
  `environment`) alongside `profile`, each layering over it — so an agent can
  reach an environment nobody saved a profile for.
- `list_profiles` reports each profile's `credential` and `readOnly`, plus the
  configured credentials, and its description tells an agent not to attempt
  writes against a read-only profile.
- Named and composite OData keys in `get_record`, `update_record`, and
  `delete_record`.
- Published ODataV4 web services through the existing `route` argument.

### Fixed

- Writes are refused against a profile marked read-only, including writes inside
  an `invoke_batch`.

## 0.2.0

- **10 `braider_*` tools** for Data Braider (24 tools total): `braider_status`, `braider_list_endpoints`, `braider_read` (filters + paging), `braider_write`, `braider_get_schema`, `braider_list_tables`, `braider_list_fields`, `braider_create_endpoint`, `braider_update_endpoint`, `braider_delete_endpoint`. Tool descriptions document the `"Table.Field"` key and `Action` write conventions for agents.

## 0.1.0-alpha.1

First public alpha. 14 typed tools over stdio, sharing profiles with the CLI:

- `list_profiles`, `set_default_company`
- `list_routes`, `list_entities`, `get_entity_schema`
- `get_records` (filter/select/orderby/top/pageSize/includeCount, returns `nextLink` + `queryUrl`), `get_next_page`, `get_record`, `get_navigation`
- `create_record`, `update_record` (transparent ETags), `delete_record`
- `invoke_action`, `invoke_batch`
