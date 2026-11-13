# PostgreSQL storage

The scheduler, dashboard and reconciler keep their rows in one PostgreSQL
database with two schemas. `crawl_budget` holds the crawler's rows. `reconciler`
holds the external sample: `provider_state`, `provider_schedule`,
`provider_runs`, `external_sightings`, `monitor_meta` and `audit_candidates`.
Every session resolves names in both. Table and column names are the ones the SQLite files used;
millisecond timestamps are still integers and `rowid` is an ordinary column.

`packages/pg/src/sync.ts` is a synchronous handle with the same small surface as
`node:sqlite`. Each handle owns one session in a worker thread and blocks the
caller until the reply arrives, so the scheduler's transactions are unchanged.
It rewrites the few SQLite-only forms the statements use: `INSERT OR IGNORE`,
`INSERT OR REPLACE`, `?` placeholders, `INDEXED BY`, and camel-case aliases.
`packages/pg/src/schema.ts` creates the tables plus `json_extract`, `unixepoch`
and `sum(boolean)` so those calls read the same.

Connection settings are the standard `PGHOST`, `PGPORT`, `PGDATABASE` and
`PGUSER` variables. The database must use the `C` collation so text compares
byte by byte, as it did before.

Validation was manual: the old SQLite code and this code were run on the same
copy of production data, and their dashboard results, claim order, request
ledger, queue, articles and robots state were compared.

## Durable availability migration

`sites.next_available_at` replaces ledger scans in scheduling. Its index selects
eligible domains. On first migration it is backfilled from the greater of the
old cooldown and the last possible dispatch/finish plus a full minute and margin.
This deliberately conservative first delay drains prior traffic, including lost workers.
`sites.cooldown` remains a compatibility mirror for rollback, not an active limiter input.
The migration is atomic and idempotent, applied with services stopped by the standard deploy.

`budget_origins(origin,last_started,next_available_at)` preserves robots crawl-delay
across subdomains and restarts, including when a later robots policy increases delay.
Old origins are seeded once from the ledger. Reservations pessimistically set their
start to the end of the uncertain-dispatch horizon; known completions replace it.
`requests.sent_at`, `budget_spacing_ms` and `budget_delay_ms` record actual send time
and the reserved rate/robots inputs; legacy values remain null. `requests.started`
retains its existing reservation-time meaning. The Python worker reports the timestamp immediately
before its HTTP call. Missing timestamps never release
an uncertain reservation early. Policy rate changes should use the same conservative
ledger backfill before enabling a lower limit; live policy reload is unsupported.
