# Crawler work trial

**Production deploys only `master`.** Merge feature work first, then run
`sudo /usr/local/sbin/deploy-exa-master` on the VM. Never deploy branch archives.
See [release safeguards and rollback](deploy/README.md).


TypeScript / Node.js 24 crawler for the 20 configured news sites. The crawler needs no API keys; optional external reconciliation uses provider keys.

## Current runtime: durable scheduler + fetch worker

The Node scheduler and Python fetch worker are separate processes. The dashboard and external reconciliation monitor run separately.
The scheduler owns PostgreSQL writes and budgets; an in-process worker thread parses archives. The fetch worker claims one-request leases
on loopback HTTP, archives responses and persists retryable receipts. The complete
fetch worker runs in Python using curl_cffi, including recovery and archive mirroring. See [protocol, recovery and deployment](docs/SCHEDULER.md).

```sh
npm run scheduler  # terminal 1; existing CRAWLER_DATA_DIR
npm run worker     # terminal 2; same data directory, no database access
```

`npm run dev` starts the scheduler only; run the worker separately.
The response archive currently uses local reads plus an asynchronous Garage mirror.
See [storage rollout, validation and rollback](docs/ARCHIVE-STORAGE.md).
The historical single-loop notes below describe the preserved discovery/parsing policies.

Site limits, enabled flags, discovery sources and optional overrides live in `config/sites.ts`, behind the
validated `policy.for()`, `policy.all()` and `policy.active()` accessors.
`config/profiles.ts` defines JSON-compatible fetch profiles and article adapters.
Omitted `fetchProfile` uses crawler headers; omitted `articleAdapter` uses generic
extraction. All publisher HTTP uses Python curl_cffi. Discovery independently uses
generic HTML/feed/sitemap readers or an explicit API adapter such as `sina-roll`.
Set `enabled: false` to pause a domain; deploy/restart all services to apply it.
See [site policies, pause behavior and shared budget rules](docs/SITE-POLICY.md).

Add ordered `discoverySources` to a site in `config/sites.ts` to choose its starting
pages, feeds, sitemaps or APIs. New sources get their first attempt in that order,
after required robots checks; later polls use the existing scheduler and budget.
See [discovery source configuration](docs/SITE-POLICY.md#discovery-sources).

## Repository layout

```text
apps/dashboard/src/{pages,api,metrics}  # UI + read-only API, one Node process
services/crawler/src/
  scheduler/                          # HTTP coordinator, leases, budgets, pipeline
services/monitor/src/                # external provider polls; no publisher HTTP
services/fetcher-impersonate/          # Python worker, HTTP clients, archives, mirroring
services/pipeline/src/extract/         # publication-date repair tool, no daemon
packages/core/src/                    # shared pure parsing, policy, types
packages/reconciliation/src/          # provider storage, matching, audit inbox
packages/db/src/                      # base schema, additive migrations, queries
config/                               # sites, limits, transport profiles
tools/simulator/                      # static import/outbound boundary check
deploy/                              # systemd + Caddy (no Docker today)
docs/                                 # decisions, metrics, architecture, move audit
```

Run all commands from the repository root. Existing npm scripts and separate dashboard
package remain; no workspace framework was added.

```sh
npm ci
npm --prefix apps/dashboard ci
python3 -m venv .venv
.venv/bin/pip install -r services/fetcher-impersonate/requirements.txt
export CRAWLER_PYTHON="$PWD/.venv/bin/python"
npm run dashboard:build
CRAWLER_DATA_DIR=/path/to/data npm run dashboard:api # UI + API on 127.0.0.1:4318
npm run dev                                       # scheduler + archive parsing thread
npm run worker                                    # separate fetch worker
```

The pipeline stays inside the scheduler process; CPU-heavy parsing runs in a built-in worker thread. Shared parsing lives in `packages/core`
because the dashboard also inspects saved responses. No service imports another service's
source. Python is the `exa-fetch-worker` service. Health remains `/api/health`.
The mapper commits parsed results in the scheduler, while the fetch worker remains database-free.

[Architecture](docs/architecture.md) · [move/content audit](docs/REORGANIZATION.md) · [deployment](deploy/README.md)

## External coverage

`npm run monitor` polls external news indexes every 10 minutes. Open `/reconciliation`
for provider-sample coverage over 10 minutes, 1 hour and 24 hours, overall and by domain;
`/api/reconciliation` keeps the per-article evidence, quotas and recent calls. Credentials
belong in private `.env.monitor`. See [matching, limits and deployment](docs/RECONCILIATION.md).

## Run in Cursor's terminal

```sh
npm ci                  # only for a fresh checkout
npm run dev             # scheduler in the foreground; Ctrl-C stops it
npm run worker          # fetch worker, in a second terminal
```

Stop a running scheduler before starting a debug session against the same data directory.
Only one crawler may use a data directory. Restarts preserve the setup clock, request
history, queues, deduplication, and collected data. Edits take effect after stop/start.
The process survives closing the terminal, but does not auto-start after reboot.
Collection pauses when the Mac sleeps or loses its network connection.

## Saved locally

- PostgreSQL schema `crawl_budget`: authoritative request ledger, sources, URL queue, article records, robots cache. See `docs/POSTGRES.md`.
- `data/articles.jsonl`: parsed records, including old, incomplete, and undated pages.
- `data/new-articles.jsonl`: records classified as new using publication evidence.
- `data/status.json`: a summary refreshed every 30 seconds.
- `data/snapshots/*.gz`: compressed response bodies, keyed by SHA-256. Request records link to them.
- `logs/crawler.log`: discovery, parsing, and failure events.

All runtime files are git-ignored. SQLite is authoritative; JSONL is an append-only
convenience export and a crash between writes can leave it behind SQLite. Responses
are limited to 5 MiB each; total disk usage is not capped. Keep the SQLite database
and its WAL together when copying a live run, or stop the crawler before copying.

## What runs

Each site gets a worker. The homepage and robots.txt seed discovery; robots-declared
sitemaps, nested sitemap indexes, and linked RSS/Atom feeds add sources. Up to 18
sources per site and three nesting levels constrain exploration (robots seeds may
add more). Homepage links are heuristic candidates, not automatically articles.
HTML feed directories are also explored for links to actual feeds.

Workers alternate discovery with up to two article fetches. Fresh publication hints
take priority, followed by newly appearing URLs. Up to eight undated baseline URLs
per site are sampled; known-old feed entries are saved but not fetched. This avoids
spending the entire request allowance downloading historical archives.

Every outbound HTTP attempt is recorded before dispatch. All subdomains share one
site budget; redirects are manual and each hop is counted. No browser subresources
or JavaScript execute. Requests outside the configured domains are refused.
First 10 minutes: at most one request/second/site. Then: configured requests/minute,
paced evenly and checked against a rolling minute, including across restarts.
Transitioning out of setup may deliberately pause requests to clear that window.

Robots rules and crawl delays apply. HTTP 429/503 respects Retry-After with a minimum
60-second site cooldown. Failures back off; articles get at most three attempts.
All sites use Python curl_cffi with Chrome 136's network fingerprint. The `crawler`
profile retains crawler headers; Hoodline and El Economista select `chrome` for
browser headers. Conditional requests use ETag/Last-Modified
and count against the allowance even when a server returns 304.

## Article fields and measurement limits

Records include canonical URL, discovery/fetch times, publication/modification times,
title, description, Open Graph/Twitter metadata, main text, and publication-date source.
JSON-LD and page metadata are preferred, with explicit feed publication dates as fallback.
Timezone-less dates are left unknown rather than interpreted in the laptop's timezone.
Sitemap `lastmod`, Atom `updated`, and article modification dates never establish freshness.

`new` requires publication at or after the site's first startup and no later than
first discovery, article evidence, a title, and at least 200 text characters. Repeated
canonical URLs and exact text duplicates are suppressed. This cannot prove a story
wasn't republished before observation began, or detect every rewritten duplicate.
Paywalls, JS-only pages, and sparse metadata can produce incomplete records.

Delay is first link discovery minus the site's claimed publication time; fetch time
is saved separately. Timestamps are publisher claims, not independently verified.
Reported averages/maxima cover only successfully parsed `new` records and may be biased.
Coverage is explicitly unknown: there is no independent ground-truth census yet.
This is a running baseline, not a completed benchmark or full 100,000-site architecture.

## Development

```sh
npm run check
npm run check:boundaries
npm run dashboard:build
```

Automated tests are removed by project preference. Do not add or run them unless
explicitly requested; see [AGENTS.md](AGENTS.md). Use builds, static checks and manual
inspection.

Set `CRAWLER_DATA_DIR` in the process environment to change storage; `.env` is not auto-loaded.
Do not run multiple instances with different data directories against the same sites:
their independent request budgets would add together.

## v1.0.1: two-site Chrome transport

The domain allowlist is hardcoded in `config/profiles.ts`. `services/fetcher-impersonate/cffi-fetch.py`
uses curl_cffi 0.17.0 with `chrome136`, browser headers, and caller-supplied conditional
headers. Python performs exactly one request: Node owns redirects, retries, robots,
raw snapshots and the shared database budget. No JavaScript browser runs.

Install Python 3.10+ dependencies in a virtual environment:

```sh
python3 -m venv .venv
.venv/bin/pip install -r services/fetcher-impersonate/requirements.txt
CRAWLER_PYTHON="$PWD/.venv/bin/python" npm run worker
```

`services/crawler/src/scheduler/budget.ts` reserves `sites.next_available_at` with
an atomic conditional PostgreSQL update in the same transaction as the request ledger.
Before dispatch it holds 35 seconds plus rate spacing. Completion uses the worker's
actual send time plus `ceil(60000/rpm) + 20ms`, or scheduler receipt time if later.
Uncertain attempts retain their reservation; active leases prevent overlap. Retry-After
extends availability. Per-origin robots delays are persisted separately. A 60.02-second
pause drains warm-up traffic before the steady-state cap. Restart never resets warm-up.
The migration conservatively backfills availability from the existing ledger.

Deploy using [deploy/README.md](deploy/README.md). The persistent database and request budget stay in place.

Judge success by usable page content and extraction, not status 200 alone.

On 2026-11-12, from the existing GCP VM, both sites returned 403 to Node (including
a repeated control) and curl_cffi with crawler headers, but 200 with the full Chrome
profile. Two article pages per site also returned 200 and yielded text, publication
dates, and social tags. This is a small transport test, not a reliability or coverage
measurement. v1.0.1 enables this transport for those two sites. The saved evidence is in
[`docs/experiments/transport-2026-11-12.json`](docs/experiments/transport-2026-11-12.json).

## v1.0: public observability

Dashboard: https://exa-crawler.34.68.179.149.sslip.io

The dashboard and read-only API run in a separate `exa-observatory` systemd service.
The existing `exa-crawler` service and its database are unchanged. Caddy serves HTTPS
and proxies to the API on loopback port 4318. Google Cloud ingress exposes only
80/443 for this dashboard; SSH remains restricted to IAP.

- Overview: fresh articles, responding sites, publisher-derived delay, request volume, per-site budget.
- Coverage and Freshness: one figure each for 10 minutes, 1 hour and 24 hours, plus the per-domain split.
- Crawler-only: crawler articles absent from the provider sample.
- Requests: cursor pagination, site/error filters, HTTP outcomes and duration; a row opens
  the candidate links reconstructed from compressed discovery responses.
- Articles: title search, site/fresh filters, publication evidence and source links.

Overview, Requests and Articles refresh every 10 seconds; Coverage, Freshness and Crawler-only
every 30 seconds. Alerts appear only when something is wrong (stale heartbeat, provider
error or quota, truncated sample, dispatch deadline failures, expired snapshot). All times
render in UTC. Overview always covers all sites; the website selector filters
requests and articles. Site health reflects the
last result for each discovery source, not a guarantee of complete article coverage.
The request inspector uses the current parser, shows at most 200 candidate links,
and does not claim they were all newly discovered in that poll. API responses omit
raw headers and full article bodies. Filters never make upstream requests.

`deploy/` contains the unchanged HTTPS proxy configuration and updated systemd entry paths.
Rows live in the PostgreSQL `crawl_budget` schema (see `docs/POSTGRES.md`); the public URL and port stay unchanged.

Useful API endpoints: `/api/overview`, `/api/summary`, `/api/requests?domain=bbc.com`,
`/api/requests/123`, `/api/articles?fresh=true&q=news`, `/api/sources`.
There are no write endpoints. API traffic is capped globally at 300 requests/10s,
with at most two simultaneous saved-response inspections.

Validation: `npm run check`, `npm run check:boundaries`, `npm run dashboard:build`,
and manual inspection. Deployments retain database backups and service health checks.

### Freshness dashboard

Open `/freshness` for the median (P50, with P90 below it) of fetch finish minus the earliest
provider publication date over 10 minutes, 1 hour and 24 hours, overall and by domain.
`/api/freshness` keeps P75 and the per-URL table. See
[freshness definitions](docs/METRICS.md#publication-to-fetch-delay).
Use `npm run dashboard:build` and `npm run dashboard:api`.
For local inspection, point `CRAWLER_DATA_DIR` and `RECONCILER_DB` at database copies.

