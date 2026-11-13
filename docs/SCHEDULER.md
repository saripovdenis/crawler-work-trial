# Durable scheduler milestone

> Deployment policy: only current `master` through
> `sudo /usr/local/sbin/deploy-exa-master`. Release-path commands below describe
> historical deployments and are retired. See [deployment documentation](../deploy/README.md).


The former `exa-crawler` unit now runs the Node scheduler and archived-response pipeline.
`exa-fetch-worker` runs Python with four concurrent fetch threads and an optional
archive mirror thread. It never opens a database. curl_cffi runs in process, with
no per-request Python startup. The dashboard/Caddy are unchanged.

## Ownership and storage

- Scheduler: PostgreSQL writes, selection, robots cache, budgets, redirects, retries, mapping and classification.
- Worker: HTTP execution, atomic gzip archives and completion receipts. It has no limiter or SQL imports.
- Shared protocol: `packages/protocol/src/index.ts`; language-independent HTTP below.
- Existing data path: `/var/lib/exa-crawler/data`; no data was moved.
- `crawl_tasks`: unique `(url,purpose)`. `url` references the existing source/candidate;
  `current_url` and `hops` retain redirect progress. Source/candidate due times are copied unchanged.
- `attempt_assignments`: unique claim ID and request-ledger ID, opaque token, worker ID,
  dispatch/lease deadlines, completion JSON and durable processing status.
- Partial unique index permits only one unterminated assignment per configured target domain.
- `scheduler_domains` persists the existing two-articles-between-polls counter.

### Robots cache

The scheduler caches robots policy for the fetcher; the worker remains stateless.
SQLite stores each policy under its full origin (scheme, host and port), not the
configured parent domain. Different Sina subdomains therefore keep separate rules,
as required by the [robots protocol](https://www.rfc-editor.org/rfc/rfc9309.html#section-2.3).
Successful policies and 404/410 results retain the existing six-hour lifetime;
401/403 deny policies retain one hour. Failures keep the existing origin cooldown.
A robots request redirected away from `/robots.txt` to an HTML page is a soft 404
and is stored like a 404; HTML served at `/robots.txt` itself remains a failure.

### Stale links

Once a minute the scheduler retires waiting article links first seen more than
three hours ago (`priority>0`, task still `ready`) as `stale`, without a request.
The row is kept, so a page that keeps showing the link does not queue it again.
`/api/overview` reports the stale count per site.

### Fresh-link turn

Every fifth article turn takes the newest waiting link with no date signal of its
own (`priority<75`) that was first seen in the last ten minutes on a proven page:
at least 12 successful polls in the last hour, at least 20 dated links fetched in
the last six hours, and at least 70% of those under an hour old when first seen.
Without such a link the turn drains the oldest waiting link as before.
`/api/cache` lists the proven pages and counts these turns.

A bounded memory cache reuses parsed rules. ETag/Last-Modified validators persist
in `meta`, tied to the exact response URL, and conditional refreshes still spend a
normal request slot. A 304 renews the existing policy, including disallow rules;
a 304 without a matching cached policy fails closed. No schema change is required.

Origins awaiting robots processing are excluded from article/source selection,
so other origins with valid policies can continue. Robots completions already use
the independent control queue; cached policies never bypass budget or crawl delay.

Migration is transactional and repeatable. Existing tables and indexes are unchanged.
New sources/candidates create tasks in the same mapping transaction. Backfill runs at
startup, not on each claim. Selection favors recent publication hints, reserves every fifth article assignment for the oldest eligible candidate, and promotes repeated homepage links. It retains eight undated baseline samples, three article attempts, robots and backoff.

## HTTP contract v1

Private loopback `http://127.0.0.1:4319`. No dashboard route exposes it. JSON only.
UTC ISO-8601 timestamps; opaque string IDs. Maximum request body 64 KiB. Health is
`GET /internal/health`. `POST` failures use `{ "error": "..." }` with 400 for invalid
input, 403 for wrong token, 404 for unknown attempt, 409 for conflict/expired lease.

`GET /internal/worker-config` returns version 1, enabled domain policies, legacy
fetch profiles and request/deadline limits from the same TypeScript configuration.
Python refuses work until it loads this configuration. All four services restart
together when policies change.

`POST /internal/claims`:

```json
{"worker_id":"fetcher-1","claim_id":"client-generated-uuid"}
```

```json
{"task":{"task_id":"123","attempt_id":"opaque-uuid","lease_token":"opaque-uuid","domain":"bbc.com","url":"https://www.bbc.com/","purpose":"discovery","transport":"curl_cffi","fetch_profile":{"impersonate":"chrome136","defaultHeaders":false,"headers":{"User-Agent":"ExaTrialCrawler/0.1","Accept":"text/html,application/xml,application/rss+xml,*/*;q=0.5"}},"headers":{},"timeout_ms":20000,"max_response_bytes":5242880,"start_by":"2026-11-12T08:00:02.000Z","lease_until":"2026-11-12T08:01:00.000Z"}}
```

New assignments use `transport: curl_cffi` and a JSON `fetch_profile` snapshot.
The worker still reads legacy `node`/`chrome136` receipts but sends all new requests
through Python, retaining the selected header style. Purpose is `robots`,
`discovery`, `article`, or `audit`.
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

Claims conditionally update `sites.next_available_at`, insert the audit request,
create the assignment and lease the task in one PostgreSQL transaction. A competing
claim must win `UPDATE ... WHERE next_available_at <= now RETURNING` before dispatch.
The initial hold is 35 seconds plus rate spacing. Completion locks the assignment,
then releases the hold to `max(actual_send + spacing, scheduler_receipt)`. Duplicate
or expired completions cannot release a newer reservation. Unknown sends keep the hold.
429/503 extend it with Retry-After. Per-origin robots spacing is durable.

Dispatch must begin within five seconds; Python checks the deadline immediately
before network dispatch. libcurl limits the request to 20 seconds; leases last
60 seconds. There is no lease renewal. One active assignment per domain prevents
overlapping requests. The 35-second uncertain-dispatch reserve remains conservative.


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

## Run and validate

From repository root, in separate terminals:

```sh
CRAWLER_DATA_DIR=/path/to/data npm run scheduler
CRAWLER_DATA_DIR=/path/to/data CRAWLER_PYTHON="$PWD/.venv/bin/python" npm run worker
```

`npm run dev` starts the scheduler only; stop the worker separately. Existing data/Python variables remain. New optional settings:
`SCHEDULER_PORT` (4319), `SCHEDULER_URL` (loopback HTTP only), `FETCH_CONCURRENCY` (4, max 20).
The scheduler takes the `crawler.pid` lock. Worker lock/receipts
live under `data/receipts`. `npm run worker` execs Python; the systemd unit starts
Python directly. SIGTERM stops new claims and lets bounded in-flight work finish.
The worker systemd sandbox makes SQLite inaccessible and only
allows writes to snapshots/receipts. Scheduler networking is restricted to loopback.

```sh
npm run check
npm run check:boundaries
```

Automated suites and their harnesses were removed by project preference. Use static
checks and manual inspection; never run the crawler against live sites for validation.

## Deployment and rollback

Deploy with the master command in [deploy/README.md](../deploy/README.md).
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

## Live audit fixes

Archive decompression, XML parsing and article extraction run in one built-in
worker thread within the scheduler process. The worker has no network or SQLite
access. Mapping yields between small transactions, so a large sitemap cannot
hold up claims for the entire document. Request limits and transport timeouts are unchanged. `/api/reconciliation` exposes last-hour assignment-to-reported
worker-start p50/p95/max, unsent completions, lease expiries and deadline failures
by transport. Worker start is a receipt timestamp, not proof of TCP send time.

Source scheduling measures new, complete articles per source over the last hour.
A repeatedly unproductive source slows down when the same site has a productive
alternative. Quiet sites keep their cadence. Old archives and repeated oversized
or unsupported responses back off for six hours. Working news sitemaps do not
lose admission slots to archived sources. Successful redirect destinations persist;
404/410 at a remembered destination reverts to the original source.

Every fifth article assignment uses the oldest positive-priority candidate. This
counter is stored in SQLite metadata and survives restart. Other article slots
favor recent publication hints; URL dates influence priority only. They never become
publication metadata. Poll timing and discovery timestamps use the archived
response's finish time; article `fetched` continues to mean parse completion.

The dispatch allowance is five seconds after measured curl_cffi imports took
1–1.24 seconds before transport setup. Uncertain reservations use a 35-second
horizon (5-second dispatch + 25-second subprocess cap + 5-second margin).
Start-based spacing and one active assignment per domain apply.
