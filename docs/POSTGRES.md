# PostgreSQL storage

The scheduler, dashboard and reconciler keep their rows in PostgreSQL, schema
`crawl_budget`. Table and column names are the ones the SQLite files used;
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
