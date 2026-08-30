---
"@navapi/core": minor
"@navapi/cli": minor
"@navapi/mcp": minor
"@navapi/ui": minor
"navapi-vscode": minor
---

Separate credentials from tenant and environment context (#17).

A credential is now a named identity of its own, and a profile references one
instead of embedding it — so several profiles can share a single app
registration and a single stored secret. Secrets are keyed by credential name.

Every face can also skip profiles entirely: `--credential`, `--tenant`, and
`--environment` (and `NAVAPI_CREDENTIAL` / `NAVAPI_TENANT` /
`NAVAPI_ENVIRONMENT`, and the same arguments on every MCP tool) layer over the
active profile, so reaching one more tenant with the same identity means naming
the tenant and nothing else.

Profiles written by any earlier version are migrated on read: each gets a
credential named after it, which means the secret already stored under that
name keeps resolving and there is no keychain migration to run. The file is
only rewritten when something changes it, and client-secret profiles keep a
legacy `clientId` so 0.2.0 can still read them.
