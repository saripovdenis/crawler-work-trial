# Response and dashboard reuse

Robots policy and request budgets are unchanged.

## Dashboard

One worker thread performs read-only dashboard queries. The API keeps a 64-entry,
64 MiB access-order LRU and coalesces concurrent refreshes for each key.
Coverage/Freshness keys contain the window, domain, provider and window semantics;
pagination and matched/unmatched filters use the cached matched dataset. Cache
lifetimes start after computation finishes:

| Data | Fresh lifetime | Maximum snapshot age |
| --- | --- | --- |
| Coverage/Freshness | 60 seconds | 5 minutes |
| Overview/parsing quality | 30 seconds | 2 minutes |
| Request/article/source lists and request wrappers | 10 seconds | 1 minute |

Within the maximum age, a stale snapshot is returned while one refresh runs.
After that limit, callers wait for a fresh result or receive 503. The original
`generatedAt` and window boundaries remain unchanged; `cache` reports age,
completion time and refresh state. The UI displays age and flags expiration.
Completed request extraction is separately reused by body hash, exact URL,
encoding, source kind, parser version and UTC day. Current request metadata is
always read independently. Coverage and Freshness retain their existing distinct
publication-window semantics.

## Archived bodies and extraction

Hash-named gzip responses are verified once per file identity and reused without
compression, writes or fsync. A changed file is revalidated; a missing/corrupt
archive is replaced atomically. Each request retains its own status, headers,
timings and charge. Network traffic is not saved by this archive reuse.

Successful extraction is stored under `snapshots/parsed/`. Keys include the body
hash, exact final URL, mode, source kind/publication hint, encoding, and an automatic
fingerprint of parser/configuration/dependency sources. Discovery additionally
includes the UTC day. The 128-entry/16 MiB memory LRU supplements the disk cache;
disk entries are pruned toward 5,000 every 256 misses. Oversized results are not
persisted. Checksums reject corrupt cache entries. Original archives remain the
source of truth. Partial discovery responses and errors are never cached.

Article observation time is rebound for every extraction use; classification and
fetch metadata are applied by the scheduler. Discovery mapping is skipped only
after a completed transaction saved the same body/version/policy signature.
Initial versus recurring polls, site start, source depth, scheduler source code
and UTC day are included.
Interrupted/partial mappings remain eligible for replay.

## Verified URL aliases

`article_aliases` stores observed 301/308 redirects and usable article canonical
links, with request evidence and a seven-day lifetime. The startup backfill uses
successful existing requests and article metadata; no external URLs are fetched.
Aliases stay within the configured site and are followed for at most eight hops;
cycles do not grant reuse. No protocol, host, slash, title or meaningful parameter
is merged by guesswork. Discovery tasks never use article alias shortcuts.

Before reserving a request, a usable article can satisfy an alias. A response
awaiting extraction causes a short durable deferral. An older verified archive is
reprocessed once per parser version before another download is considered. A
failed extraction does not indefinitely suppress a deliberate budgeted refetch.
Incomplete results do not satisfy the usable-result shortcut. Repaired rows keep
original discovery/fetch timestamps and record `reprocessedAt`; request records
and budget charges are never rewritten. Existing deliberate repair/refetch paths
remain available.

## Measurement and validation

`GET /api/cache` exposes dashboard hits, coalesced refreshes, query duration,
evictions and queued work; archive reuse/writes/repairs; avoided extraction and
downloads; mapping reuse; parse backlog/change/growth; and requests started in the
last minute. Crawler snapshots update every 30 seconds. Counters are operational
measurements, not billing: parser/dashboard counters reset with their process;
archive counters persist periodically and can lose the final unflushed interval.

Manual checks on the saved database/pages (no test suite or publisher requests):
- Coverage/Freshness values matched the previous implementation for selected
  pages and filters. A 772 ms first query became a 1.5 ms cached page/filter read.
- A saved BBC extraction took 172 ms initially, 0.07 ms from memory and 0.56 ms
  after reopening its disk cache; article text matched and observation times changed.
- Duplicate archives kept their mtime; a corrupted copy was repaired.
- A verified saved article avoided a download without changing request count or
  site start times. A controlled incomplete-row replay used the saved response,
  restored the usable result, preserved timestamps and added no request.

These local timings do not predict VM throughput. Live cache counters and backlog
growth must be observed after deployment; this change does not increase limits
or remove the scheduler's separate capacity constraints.
