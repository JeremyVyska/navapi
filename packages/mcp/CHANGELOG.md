# @navapi/mcp

## 0.1.0-alpha.1

First public alpha. 14 typed tools over stdio, sharing profiles with the CLI:

- `list_profiles`, `set_default_company`
- `list_routes`, `list_entities`, `get_entity_schema`
- `get_records` (filter/select/orderby/top/pageSize/includeCount, returns `nextLink` + `queryUrl`), `get_next_page`, `get_record`, `get_navigation`
- `create_record`, `update_record` (transparent ETags), `delete_record`
- `invoke_action`, `invoke_batch`
