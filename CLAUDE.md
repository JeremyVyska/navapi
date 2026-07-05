# navapi — agent notes

Discovery-first toolkit for Microsoft Dynamics 365 Business Central APIs. pnpm monorepo, four packages: `packages/core` (`@navapi/core` — the brain), `packages/cli` (`@navapi/cli`, installs the `navapi` command), `packages/mcp` (`@navapi/mcp`), `packages/vscode` (`navapi-vscode` extension, ships as `.vsix`).

**Design rule:** anything not UI-specific goes in `core`. The faces stay thin and all resolve profiles/secrets through `createClientForProfile()` / `resolveSecretStore()`.

## Commands

```bash
pnpm build            # tsup, all packages
pnpm test             # vitest, all packages (~130 tests)
pnpm lint / lint:fix  # biome (formatter is strict; LF enforced via .gitattributes)
pnpm --filter navapi-vscode package   # builds the .vsix (bump the version FIRST — see below)
cd packages/vscode && npx tsc --noEmit  # only package that needs a manual typecheck
```

## Non-obvious rules (each learned the hard way)

- **BC string fields are present-but-empty**, never rely on `??` for fallbacks. Use `companyLabel()` from core.
- **`$top` never yields `@odata.nextLink`.** Paging = `Prefer: odata.maxpagesize` (`ListOptions.maxPageSize`). `$top` is only a hard cap.
- **Route enumeration is company-scoped**: runtime API `GET <env>/api/microsoft/runtime/beta/companies(<id>)/apiRoutes` (then v1.0, then bare `api/routes`, then plain `v2.0`). No company → only standard routes appear.
- **ETag pattern:** GET → `If-Match` → retry once on 412 → surface. Lives in core only.
- **`@napi-rs/keyring` must stay in tsup `external`** (core AND vscode configs) — esbuild chokes on `.node` files. The vsix gets it via `packages/vscode/scripts/copy-keyring.mjs` → `dist/node_modules` (single-platform: host's binding only).
- **Always bump `packages/vscode/package.json` version before packaging a vsix** — VS Code silently keeps stale same-version installs. The records panel shows `v<version>` in its toolbar to diagnose this.
- **Webviews:** toggle CSS classes, never `style.display = ''` (stylesheet default wins). All grid/filter logic is pure TS (`grid.ts`, `filter.ts`, `webview.ts`) tested in jsdom (`test/webview-dom.test.ts` executes the real embedded script). Record data is rendered DOM-only (XSS).
- **fast-xml-parser:** with `attributeNamePrefix: ''`, the `isArray` callback must check its `isAttribute` argument or attribute names collide with element names.
- **Secrets:** never write to the real keychain from tests/smokes — set `NAVAPI_SECRET_BACKEND=file` (CI does; smoke scripts do).
- **CLI `--json` output shape is a stability promise** — bare arrays/objects by default; envelopes only behind opt-in flags (e.g. `--count`).

## Testing

Unit tests mock `fetch` via injection (see `packages/core/test/helpers.ts`). The fake BC server used for E2E smokes lives in the session scratchpad, not the repo — it mirrors *documented* BC semantics (e.g. `$top` vs `maxpagesize`); don't let test doubles encode assumptions. Live-tenant validation happened 2026-07-05 against a real env (22 routes, 645 entity sets, full CRUD) — profile `live-test` may still exist in `~/.navapi`.

Config dir: `~/.navapi` (`NAVAPI_CONFIG_DIR` override) — `profiles.json`, keychain-backed secrets (file fallback `secrets.json`), `cache/<profile>/<route>.json` metadata, `companies/`, `counts/`. Env vars: `NAVAPI_PROFILE`, `NAVAPI_CLIENT_SECRET`, `NAVAPI_AUTHORITY` (sovereign clouds/test servers), `NAVAPI_SECRET_BACKEND`.

## Release

`v0.1.0-alpha.1` tagged; GitHub Release carries the CI-built vsix (`gh run download <id> --name navapi-vscode-vsix`). npm publish: `pnpm -r publish --tag alpha --no-git-checks` — requires the user's OTP interactively; the bare `navapi` npm name is squatted (CLI is `@navapi/cli`, bin is still `navapi`). CI: `.github/workflows/ci.yml` (ubuntu/windows × node 20/22; pnpm needs `standalone: true` because pnpm 11 requires Node ≥22.13).
