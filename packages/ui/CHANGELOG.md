# @navapi/ui

## 0.3.0

First release. A secure local web application for browsing Business Central
APIs, for people who want a graphical interface without installing VS Code.

- Starts with `navapi ui`, opens your default browser, and shares the profiles,
  credentials, companies, discovery cache, and OS-keychain secrets that the CLI
  and the VS Code extension already use.
- VS Code-style collapsible sidebar, endpoint tree with official Codicons,
  records browsing with filtering, selection, sorting, paging, and navigation
  properties, schema views, and an OData query builder. Light and dark themes.
- Loopback-only binding with a per-session bearer token that never appears in
  the HTML or in browser history, Host and Origin validation (including
  canonical default-port handling), a strict nonce CSP, same-origin local asset
  delivery, single-cursor paging that rejects replay, and an idle timeout with
  wake heartbeats so a throttled background tab does not shut the server down.
- Windows install and launch scripts for people who do not have Node.
