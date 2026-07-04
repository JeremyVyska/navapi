# navapi (CLI)

The Business Central API CLI that doesn't make you cry. 🧭 Thin wrapper over [`@navapi/core`](../core/README.md).

```bash
# One profile per BC environment
navapi profile add contoso-prod --tenant $TENANT_ID --client-id $CLIENT_ID \
  --environment Production --company "CRONUS International Ltd."

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
navapi delete salesOrders <id> --yes
```

Humans on a TTY get tables; pipes and `--json` get stable JSON.

Secrets go to the **OS keychain** when available (file fallback otherwise; `NAVAPI_CLIENT_SECRET` env var covers CI). `navapi secrets status` shows where each profile's secret lives; `navapi secrets migrate` moves any plaintext leftovers into the keychain.
