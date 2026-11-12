# Runtime architecture

`exa-crawler` starts `services/crawler/src/loop/index.ts`. Its unchanged worker calls
the fetcher and shared pipeline functions, writes snapshots and SQLite, and persists
request reservations through the scheduler. `packages/core` contains pure extraction,
discovery and newness logic. `services/pipeline` exposes those functions as a library;
it has no running process and sends no HTTP requests.

The fetcher's transport invokes `services/fetcher-impersonate/cffi-fetch.py` for the
two configured Chrome-profile domains. Each invocation handles exactly one request;
the crawler retains budgets, robots, redirects and retries. See its README for JSON shapes.

`exa-observatory` starts `apps/dashboard/src/api/index.ts`. It serves `apps/dashboard/dist`
and queries SQLite using separate read-only connections. Caddy proxies HTTPS to
`127.0.0.1:4318`. No app or pipeline code contacts news sites.

Persistent production data remains `/var/lib/exa-crawler/data`. Code releases can move;
the database, snapshots, site start times, queues and request ledger do not.

`npm run check:boundaries` rejects common outbound HTTP calls outside the fetcher,
cross-service imports and database use in the Python helper. Tests prove rejection.
This is a lexical guard, not a security sandbox; runtime integration tests use fixtures
with actual Node sockets blocked. Test utilities and browser UI are outside the guard.
