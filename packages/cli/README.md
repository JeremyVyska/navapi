# navapi (CLI)

The Business Central API CLI that doesn't make you cry. 🧭 Thin wrapper over [`@navapi/core`](../core/README.md).

```bash
# One profile per BC environment
navapi profile add contoso-prod --tenant $TENANT_ID --client-id $CLIENT_ID \
  --environment Production --company "CRONUS International Ltd."

# Or, if you're already signed in with `az login`: no app registration, no secret
navapi profile add contoso-dev --tenant $TENANT_ID --environment Sandbox-UAT --auth azureCli
navapi profile az-accounts         # which identities az is signed in as (--az-account picks one)

# Refuse every write through a profile (guardrail against accidental/agent writes,
# NOT a security boundary — use a read-only BC permission set for that)
navapi profile add contoso-prod --tenant $TENANT_ID --client-id $CLIENT_ID --environment Production --read-only

# One identity, many environments: save the credential once, point it wherever
navapi credential add contoso-app --client-id $CLIENT_ID --secret $SECRET
navapi profile add contoso-uat --credential contoso-app --tenant $TENANT_ID --environment Sandbox-UAT
navapi credential list             # identities, and the profiles each backs

# ...or skip profiles entirely — these layer over whichever profile is active
navapi get customers --tenant $OTHER_TENANT
navapi discover --credential contoso-app --tenant $T --environment Production

navapi company list                # companies in the environment (● = current default)
navapi company use                 # switch the default company (interactive picker on a TTY)
navapi routes                      # every API route the environment exposes
navapi discover                    # ingest $metadata from all routes → collection tree
navapi discover customer --schema  # the shape of anything matching "customer"
navapi ls                          # browse the cached tree offline

navapi profile test                # verify credentials: token grant + company fetch
navapi get customers --top 10
navapi get customers --count --show-url            # "x of Y" totals + the request URL on stderr
navapi get salesOrders <id> --nav salesOrderLines  # navigation properties (FastTabs for the terminal)
navapi get salesOrders --filter "status eq 'Open'" --json | jq '.[].number'
navapi patch customers <id> --set blocked=All     # ETags handled for you
navapi post Customer --route ODataV4 --body customer.json
navapi patch SalesLine --route ODataV4 \
  --key '{"Document_Type":"Order","Document_No":"SO-1","Line_No":10000}' \
  --set Quantity=2
navapi delete salesOrders <id> --yes

# Dedicated browser UI (loopback-only, authenticated per process)
navapi ui
```

Humans on a TTY get tables; pipes and `--json` get stable JSON.

Secrets go to the **OS keychain** when available (file fallback otherwise; `NAVAPI_CLIENT_SECRET` env var covers CI). `navapi secrets status` shows where each profile's secret lives; `navapi secrets migrate` moves any plaintext leftovers into the keychain.

`navapi ui` opens a read-only local web application using the same profiles, secrets, companies, and metadata cache. Use `--no-open` for headless startup; it prints the process-scoped authenticated URL, which must be treated as a secret. Use `--idle-timeout <seconds>` to change how long the server waits after browser heartbeats stop. On headless Linux systems without a desktop keyring session, set `NAVAPI_SECRET_BACKEND=file` deliberately.

See the [web UI installation guide](../../docs/ui.md) for complete npm, Windows,
and headless setup instructions.
