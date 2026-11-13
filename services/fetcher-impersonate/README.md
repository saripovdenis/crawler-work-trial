# Python fetch worker

`worker.py` is the complete `exa-fetch-worker` service: concurrent claims,
curl_cffi HTTP, immutable gzip archives, durable completion receipts and optional
background Garage uploads. No Node process or per-request subprocess runs inside
this worker. No database access, limiter, parser, automatic redirects or HTTP retries.
The Node scheduler reserves every publisher request before assigning it.

## Run

From the repository root:

```sh
python3 -m venv .venv
.venv/bin/pip install -r services/fetcher-impersonate/requirements.txt
.venv/bin/python -B services/fetcher-impersonate/worker.py --check
CRAWLER_PYTHON="$PWD/.venv/bin/python" npm run worker
# Equivalent:
.venv/bin/python services/fetcher-impersonate/worker.py
```

`CRAWLER_DATA_DIR` defaults to `data`, `SCHEDULER_URL` to loopback
`http://127.0.0.1:4319`, and `FETCH_CONCURRENCY` to 4 (1–20). `CRAWLER_PYTHON`
selects the interpreter for the npm command. Systemd starts the release virtualenv
Python directly. SIGTERM stops new claims and drains bounded in-flight work.
`--check` imports the worker without network requests or runtime-file writes.

## Configuration and HTTP contract

`config/sites.ts` selects JSON-compatible definitions in `config/profiles.ts`.
Omitting `fetchProfile` selects crawler headers. Optional `articleAdapter` belongs
to the Node parsing pipeline; the Python worker only downloads and archives bytes.
There is no Python copy of the site list. Before claiming work the worker reads
`GET /internal/worker-config` from the loopback scheduler:

```json
{
  "version": 1,
  "sites": [{"domain": "hoodline.com", "enabled": true}],
  "legacy_profiles": {
    "node": {"impersonate": "chrome136", "defaultHeaders": false, "headers": {"User-Agent": "ExaTrialCrawler/0.1", "Accept": "text/html,application/xml,application/rss+xml,*/*;q=0.5"}},
    "chrome136": {"impersonate": "chrome136", "defaultHeaders": true, "headers": {}}
  },
  "limits": {"timeout_ms": 20000, "max_response_bytes": 5242880, "dispatch_ms": 5000}
}
```

`POST /internal/claims` accepts `{"worker_id":"uuid","claim_id":"uuid"}`.
The scheduler returns either `{"task":null,"retry_after_ms":1000}` or:

```json
{
  "task": {
    "task_id": "123", "attempt_id": "uuid", "lease_token": "uuid",
    "domain": "hoodline.com", "url": "https://hoodline.com/rss", "purpose": "discovery",
    "transport": "curl_cffi",
    "fetch_profile": {"impersonate": "chrome136", "defaultHeaders": true, "headers": {}},
    "headers": {"If-None-Match": "example"},
    "timeout_ms": 20000, "max_response_bytes": 5242880,
    "start_by": "2026-11-13T08:00:05.000Z", "lease_until": "2026-11-13T08:01:00.000Z"
  }
}
```

Per-request headers override static profile headers. `impersonate` selects the
Chrome 136 network fingerprint, not a headless browser. The worker checks the
configured domain, enabled flag, limits and dispatch deadline before sending.
Each thread uses a fresh curl session per request, without shared cookies.

`POST /internal/attempts/:attempt_id/complete` sends:

```json
{
  "lease_token": "uuid", "started_at": "2026-11-13T08:00:00.100Z",
  "fetch_finished_at": "2026-11-13T08:00:00.200Z", "finished_at": "2026-11-13T08:00:00.210Z",
  "status": 200, "headers": {"content-type": "text/html"},
  "body_hash": "64-lowercase-hex-characters", "response_ref": "snapshots/<body_hash>.gz",
  "bytes": 1000, "error": null
}
```

The response is `{"outcome":"completed"}` or an existing terminal outcome such as
`expired`. Failed requests have `error`; unsent attempts have `started_at:null`.
No body travels through the scheduler API. `response_ref` is relative to the shared
local data directory. The database schema and these JSON shapes are the
cross-language contract; Python does not open the database.

## Persistence and recovery

- `receipts/worker-id`, numbered receipt files and `fetch-worker.pid` keep their
  existing formats. A stable flock plus the PID file prevents overlapping workers.
- Claim identity and dispatch intent are fsynced before their respective requests.
- `snapshots/<sha256>.gz` hashes decompressed bytes. Existing archives are verified
  and reused; corrupt archives are rewritten. Verification uses a bounded LRU.
- A completed receipt retries acknowledgement without repeating the publisher
  request. A dispatched receipt without a result waits for its lease horizon and
  reports `Worker restarted; outcome unknown`. Uncertain attempts stay charged.
- Existing `node`/`chrome136` assignments and receipts remain readable. Old
  receipts outside the current concurrency range are drained too.
- `receipts/archive-cache-metrics.json` and the `CRAWLER_TIMING_LOGS=1` JSON format
  remain available. `response_wait_scope` is now `python_full_response`.

## Optional archive mirror

With `ARCHIVE_MIRROR=1`, the background Python thread drains the existing
`receipts/archive-mirror/{pending,uploaded}` queue. It uploads verified local gzip
bytes and preserves the existing markers and `archive-mirror-metrics.json` format.
Uploads do not hold publisher slots. Failed uploads back off, up to 60 seconds.

`ARCHIVE_S3_ENDPOINT`, `ARCHIVE_S3_BUCKET`, `ARCHIVE_S3_REGION`,
`ARCHIVE_S3_ACCESS_KEY` and `ARCHIVE_S3_SECRET_KEY` retain their meanings. Only
loopback HTTP endpoints are accepted. libcurl signs a fixed-path PUT with AWS
Signature V4 and an explicit payload SHA-256; redirects and implicit retries are
disabled. Credentials are never written into receipts or logs.

## Legacy diagnostic CLI

`cffi-fetch.py` remains a one-request stdin/stdout adapter around the same client.
It accepts `{"url":"...","profile":{...},"headers":{},"start_by":"..."}`;
legacy `cffi-chrome` and `cffi-crawler` profile strings remain supported. It returns
status, headers, base64 body, version and HTTP-version metadata, or an error object.
Production does not spawn this CLI.
