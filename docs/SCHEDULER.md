# Durable scheduler milestone

The former `exa-crawler` unit now runs the Node scheduler and archived-response pipeline.
`exa-fetch-worker` is a second Node process with four concurrent slots. It never opens
SQLite. Python remains a one-request Chrome 136 subprocess. The dashboard/Caddy are unchanged.

## Ownership and storage

- Scheduler: SQLite writes, selection, robots cache, budgets, redirects, retries, mapping and classification.
- Worker: HTTP execution, atomic gzip archives and completion receipts. It has no limiter or SQL imports.
- Shared protocol: `packages/protocol/src/index.ts`; language-independent HTTP below.
- Existing data path: `/var/lib/exa-crawler/data`; no data was moved.
- `crawl_tasks`: unique `(url,purpose)`. `url` references the existing source/candidate;
  `current_url` and `hops` retain redirect progress. Source/candidate due times are copied unchanged.
- `attempt_assignments`: unique claim ID and request-ledger ID, opaque token, worker ID,
  dispatch/lease deadlines, completion JSON and durable processing status.
- Partial unique index permits only one unterminated assignment per configured target domain.
- `scheduler_domains` persists the existing two-articles-between-polls counter.

Migration is transactional and repeatable. Existing tables and indexes are unchanged.
New sources/candidates create tasks in the same mapping transaction. Backfill runs at
startup, not on each claim. Selection retains first-poll priority, fresh candidate priority,
eight undated baseline samples, source intervals, three article attempts, robots and backoff.

## HTTP contract v1

Private loopback `http://127.0.0.1:4319`. No dashboard route exposes it. JSON only.
UTC ISO-8601 timestamps; opaque string IDs. Maximum request body 64 KiB. Health is
`GET /internal/health`. `POST` failures use `{ "error": "..." }` with 400 for invalid
input, 403 for wrong token, 404 for unknown attempt, 409 for conflict/expired lease.

`POST /internal/claims`:

```json
{"worker_id":"fetcher-1","claim_id":"client-generated-uuid"}
```

```json
{"task":{"task_id":"123","attempt_id":"opaque-uuid","lease_token":"opaque-uuid","domain":"bbc.com","url":"https://www.bbc.com/","purpose":"discovery","transport":"node","headers":{},"timeout_ms":20000,"max_response_bytes":5242880,"start_by":"2026-11-12T08:00:02.000Z","lease_until":"2026-11-12T08:01:00.000Z"}}
```

`transport` is `node` or `chrome136`; purpose is `robots`, `discovery`, or `article`.
No work: `{ "task": null, "retry_after_ms": 1000 }`. After receiving no work, generate
a new claim ID. If the response is lost, retry the same ID. Assigned IDs are permanently
idempotent: they return the original assignment even after completion/expiry. A worker
must check `start_by` and must never re-execute a locally dispatched receipt.

`POST /internal/attempts/{attempt_id}/complete`:

```json
{"lease_token":"opaque-uuid","started_at":"2026-11-12T08:00:01.000Z","finished_at":"2026-11-12T08:00:02.000Z","status":200,"headers":{"content-type":"text/html"},"body_hash":"64-lowercase-sha256-hex-characters","response_ref":"snapshots/HASH.gz","bytes":18342,"error":null}
```

Headers use lowercase keys. Hash and bytes refer to the decompressed response body.
Archive even empty/304 bodies. On failure, `status` may be null, hash/ref are null,
bytes is zero, and error is a string; `started_at` is null if dispatch never happened.
Success: `{ "outcome": "completed" }`. Repeated reports return the recorded terminal
outcome (`completed` or `expired`) without changing request/processing records. A late
result for an expired assignment cannot overwrite a replacement. An unknown attempt is
an error; the worker retains its receipt for operator inspection rather than refetching.

## Crash and safety rules

Claims reserve the existing ledger, create the assignment and lease the task in one
`BEGIN IMMEDIATE` transaction. Existing rolling-window, completion-spacing, startup and
cooldown calculations are reused. Worker timestamps are measurements; `requests.finished`
is scheduler-observed. Expired attempts receive the observed expiry time and remain charged.

Dispatch must begin within two seconds; Node/Python enforce the deadline immediately
before network dispatch. Requests time out after 20 seconds (Python subprocess also has
its existing 25-second cap); leases last 60 seconds. There is no lease renewal. Safe expiry
plus conservative completion spacing precedes another assignment for that domain.

Worker slots fsync their claim ID before claiming and dispatch intent before fetching.
Archives and completed receipts use temporary-file + fsync + rename + directory-fsync.
After a crash, a dispatched slot without a result waits for the safety horizon and reports
an unknown outcome. A completed receipt is resent until acknowledged. No claim or
completion retry repeats a locally recorded dispatch. This is not exactly-once website I/O.

Completion records `processing=pending` and `task=downloaded` durably. The coordinator
checks archive size/hash and applies mapping transactionally. Exceptions retry the same
archive with backoff, without another website request. No source poll/success timestamp
advances until mapping succeeds. Existing parse/classify functions and dashboard columns
are reused. Article `fetched` still means parse completion. SQLite remains authoritative;
JSONL exports retain their previous best-effort guarantee.

## Run and test

From repository root, in separate terminals:

```sh
CRAWLER_DATA_DIR=/path/to/data npm run scheduler
CRAWLER_DATA_DIR=/path/to/data npm run worker
```

`npm run dev` and detached `npm start` now start the scheduler only. `npm stop` stops it;
stop the worker separately. Existing data/Python variables remain. New optional settings:
`SCHEDULER_PORT` (4319), `SCHEDULER_URL` (loopback HTTP only), `FETCH_CONCURRENCY` (4, max 20).
The scheduler takes the same `crawler.pid` lock as the legacy loop. This release rejects
standalone probes and legacy-loop startup once the durable tables exist. Worker lock/receipts
live under `data/receipts`. The worker systemd sandbox makes SQLite inaccessible and only
allows writes to snapshots/receipts. Scheduler networking is restricted to loopback.

```sh
npm run check
npm test
npm run check:boundaries
npm run check:shadow -- /path/to/snapshot.sqlite
npm run check:durable -- /path/to/snapshot.sqlite
.venv/bin/python services/fetcher-impersonate/check-cffi.py
```

Tests contact loopback simulators only. Snapshot checks create disposable backups;
they never write the input. The two-process rehearsal substitutes saved news fixtures
and blocks non-loopback sockets. Unit/contract tests cover concurrent claims, retries,
expiry, robots, redirects, 304/429, oversized bodies, timeout, lost ACKs, unknown dispatch,
parser failure, worker dependency boundaries and unchanged dashboard behavior.

## Deployment and rollback

Upload a committed release to `/opt/exa-crawler/durable-COMMIT` and run
`sudo bash deploy/deploy-durable.sh /opt/exa-crawler/durable-COMMIT`.
Preflight runs tests and both copied-database checks while the old loop continues.
Only then: stop the executor (if present), stop the old loop, save `before-cutover.sqlite`,
install units, start the scheduler, wait for private health, start the worker.
Dashboard and Caddy are not restarted. No old/new loop overlap is allowed.

Rollback: stop worker, stop scheduler, wait 60 seconds, restore the previous crawler
unit from the release's `deploy/previous-units`, daemon-reload, start the old crawler.
Disable the fetch-worker unit when rolling back to the single-loop release. Keep the
current database and ledger; do not restore a stale snapshot and discard budget charges.
The old loop ignores additive tables. Before returning from a legacy rollback to this
architecture, reconcile task due/state with changed legacy source/candidate rows on a
copy; a blind return to stale durable tasks is not supported.
