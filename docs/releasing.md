# Releasing navapi

A release is one git tag. `.github/workflows/release.yml` does the rest, except
the Marketplace upload, which is manual on purpose — see below.

```bash
# 1. bump every package to the same version, update the changelog
# 2. commit, then:
git tag v0.3.0
git push origin v0.3.0
# 3. approve the npm-release environment when GitHub asks
# 4. upload the vsix from the drafted GitHub Release to the Marketplace
# 5. publish the draft release
```

## What the workflow does

| job | what it does |
| --- | --- |
| `verify` | build, lint, the full test suite, a smoke of the built CLI, and a check that the tag matches every package's version |
| `publish-npm` | publishes the four public packages to npm via trusted publishing — gated behind the `npm-release` environment |
| `package-vsix` | builds the universal `.vsix` (every platform's keyring binding in one file) |
| `github-release` | drafts a GitHub Release with the vsix attached |

The version check exists because a tag that disagrees with the manifests
publishes the wrong version under the right name, and npm does not let you take
that back. It refuses the release instead.

## npm: trusted publishing, no token

There is no `NPM_TOKEN` and no OTP prompt. npm trusts **this repository and this
workflow file by name**, and the job mints a short-lived OIDC token at publish
time (`permissions: id-token: write`).

Consequences worth knowing:

- **Renaming `release.yml` breaks publishing** until the trusted publisher
  entries on npmjs.com are updated to match the new filename.
- **Only GitHub-hosted runners work.** Self-hosted runners cannot issue an OIDC
  token npm accepts.
- **The publish job pins Node 22.** npm's OIDC exchange requires 22.14+; the
  test matrix in `ci.yml` still covers Node 20 for the library itself.
- **pnpm does the exchange itself** (`publish/oidc/authToken.js`, hitting
  `/-/npm/v1/oidc/token/exchange/package/<name>`). It works from pnpm 11.1 or
  so; **11.0.8 had a regression that fails with a 404**. `packageManager` in the
  root `package.json` pins the version, which makes that pin load-bearing for
  releases — do not lower it.

### One-time setup on npmjs.com

For **each** of `@navapi/core`, `@navapi/cli`, `@navapi/mcp`, and `@navapi/ui`:
package settings → Trusted Publisher → GitHub Actions, with

| field | value |
| --- | --- |
| organization or user | `JeremyVyska` |
| repository | `navapi` |
| workflow filename | `release.yml` |
| environment | `npm-release` |

Then, in the repository's settings, create the `npm-release` environment and add
yourself as a **required reviewer**. Without that the gate is decorative and any
pushed tag publishes unattended.

### Bootstrapping a brand-new package

A trusted publisher is configured in *a package's* settings, so the package has
to exist on npm first. A package that has never been published — `@navapi/ui`
was in this position for 0.3.0 — must be published once by hand:

```bash
# a real terminal: this prompts for your OTP
pnpm --filter @navapi/ui publish --access public
```

**It must be `pnpm publish`, not `npm publish`.** Every package here depends on
its siblings through `"@navapi/core": "workspace:*"`, and the workspace protocol
is a pnpm/yarn thing npm does not understand. `npm pack` leaves the literal
`workspace:*` in the published manifest, which the registry rejects as an
invalid version range; `pnpm pack` rewrites it to the real version. To see it
for yourself before publishing anything:

```bash
pnpm --filter @navapi/ui pack --pack-destination /tmp
tar -xzOf /tmp/navapi-ui-<version>.tgz package/package.json   # deps must read 0.3.0, not workspace:*
```

After that first publish, configure its trusted publisher like the others and it
joins the automated flow. Until you do, `pnpm -r publish` fails on it and takes
the whole release job with it.

Publishing it by hand does not clash with the tag that follows: `pnpm publish`
skips a package whose version is already in the registry — that is what
`--force` exists to override — so the release job just publishes the other
three.

## VS Code Marketplace: still manual, deliberately

The vsix is built by CI and attached to the drafted GitHub Release; uploading it
at <https://marketplace.visualstudio.com/manage/publishers/jeremyvyska> is a
manual step. That is not laziness — as of August 2026 there is no supported
path from GitHub Actions:

- `vsce publish` authenticates with an **Azure DevOps PAT**, and the docs
  require one scoped to *All accessible organizations* — a **global** PAT.
- Microsoft retires global PATs on **2026-12-01**. (The earlier plan to block
  new ones from 2026-03-15 was cancelled, so you can still create one today.)
- Organization-scoped PATs survive the retirement, but nobody has confirmed the
  Marketplace accepts one —
  [microsoft/vsmarketplace#2121](https://github.com/microsoft/vsmarketplace/issues/2121)
  is open with no response.
- The replacement Microsoft recommends, `vsce publish --azure-credential` with
  Entra ID, is documented only for **Azure DevOps Pipelines** with a
  user-assigned managed identity. The one public report of using it from GitHub
  Actions with a federated service principal
  ([vscode-vsce#1023](https://github.com/microsoft/vscode-vsce/issues/1023))
  failed and was closed as not planned.

The manual web upload uses your browser session, not a PAT, so it is unaffected
by any of this and will keep working. Automating it is tracked in #25; revisit
when Microsoft answers.
