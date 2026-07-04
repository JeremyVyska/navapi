# @navapi/mcp

Model Context Protocol server for Microsoft Dynamics 365 Business Central. Agents get typed tools instead of shelling out to a CLI — same [`@navapi/core`](../core/README.md) brain, one tool call ≈ one CLI command.

## Tools

| Tool | What it does |
| --- | --- |
| `list_profiles` | Configured profiles (one per BC environment) |
| `set_default_company` | Switch the profile's default company (validated against the environment) |
| `list_routes` | Every API route the environment exposes |
| `list_entities` | Collection tree per route, from cached `$metadata` (auto-discovers) |
| `get_entity_schema` | Properties, keys, navigation properties, bound actions |
| `get_records` / `get_record` | OData queries with filter/select/top/…; returns `count` (opt-in), `nextLink`, and the exact `queryUrl` |
| `get_next_page` | Continue a paged `get_records` result from its `nextLink` |
| `get_navigation` | Fetch a record's navigation property (order lines, currency, …) |
| `create_record` / `update_record` / `delete_record` | Writes with transparent ETag handling |
| `invoke_action` | Bound actions (`shipAndInvoice`, `Microsoft.NAV.*`, custom namespaces) |
| `invoke_batch` | OData `$batch` with `{company}` substitution and per-request results |

## Setup

Profiles are shared with the `navapi` CLI — create them there:

```bash
navapi profile add contoso-prod --tenant ... --client-id ... --environment Production --company "..."
```

Then register the server with your MCP host (stdio transport):

```jsonc
{
  "mcpServers": {
    "navapi": { "command": "navapi-mcp" }
  }
}
```

Environment variables: `NAVAPI_PROFILE` (default profile), `NAVAPI_CLIENT_SECRET`, `NAVAPI_CONFIG_DIR`, `NAVAPI_AUTHORITY`.
