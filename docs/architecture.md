# Current runtime architecture

- `exa-crawler`: private HTTP scheduler plus archived-response processing, `127.0.0.1:4319`.
- `exa-fetch-worker`: four bounded request slots, atomic archives and completion receipts; no SQLite access.
- Python curl_cffi: one-request child for the two configured Chrome-profile domains.
- `exa-observatory`: unchanged read-only API and dashboard on loopback 4318, behind Caddy.

Scheduling, budgets, leases, mapping and writes belong to the coordinator. The worker
communicates only through the language-neutral HTTP contract and shared archive/receipt files.
Parsing stays in the coordinator, using the existing shared extraction/classification functions.
See [protocol, recovery and cutover](SCHEDULER.md).

## Previous layout-only milestone


`exa-crawler` starts `services/crawler/src/loop/index.ts`. Its unchanged worker calls
the fetcher and shared pipeline functions, writes snapshots and SQLite, and persists
request reservations through the scheduler. `packages/core` contains pure extraction,
discovery and newness logic. `services/pipeline` exposes those functions as a library;
it has no running process and sends no HTTP requests.

`exa-fetch-worker` runs `services/fetcher-impersonate/worker.py` directly. Python
owns claims, receipt recovery, curl_cffi requests, immutable local archives and
background mirror uploads. It never opens the database. JSON-compatible profiles
in `config/profiles.ts` are selected by each entry in `config/sites.ts`; the scheduler
serves startup policy as JSON and includes a profile snapshot in each assignment.
The scheduler retains budgets, robots, redirects and retries.

`exa-observatory` starts `apps/dashboard/src/api/index.ts`. It serves `apps/dashboard/dist`
and queries SQLite using separate read-only connections. Caddy proxies HTTPS to
`127.0.0.1:4318`. No app or pipeline code contacts news sites.

Persistent production data remains `/var/lib/exa-crawler/data`. Code releases can move;
the database, snapshots, site start times, queues and request ledger do not.

`npm run check:boundaries` rejects common outbound HTTP calls outside the fetcher,
cross-service imports and database use in the Python helper.
This is a lexical guard, not a security sandbox. Simulator utilities and browser UI
are outside the guard. Automated suites were removed by project preference.
