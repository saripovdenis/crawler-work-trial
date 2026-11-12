# Crawler work trial

Local TypeScript / Node.js 24 crawler for the 20 configured news sites. No keys needed.

## Run in Cursor's terminal

```sh
npm ci                  # only for a fresh checkout
npm start               # detached background process; returns to terminal
npm run status          # per-site requests, parsing, fresh articles, errors
tail -f logs/crawler.log # live JSON event stream; Ctrl-C only exits tail
npm run stop            # graceful shutdown
```

`npm run dev` runs in the foreground. Stop the background process before debugging.
Only one crawler may use a data directory. Restarts preserve the setup clock, request
history, queues, deduplication, and collected data. Edits take effect after stop/start.
The process survives closing the terminal, but does not auto-start after reboot.
Collection pauses when the Mac sleeps or loses its network connection.

## Saved locally

- `data/crawler.sqlite`: authoritative request ledger, sources, URL queue, article records, robots cache.
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
403 responses are reported, not bypassed. Conditional requests use ETag/Last-Modified
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
npm test
```

Tests cover setup/steady-state limits, the transition, shared domain mapping, parser
fixtures, freshness, and mocked transport accounting for robots, redirects, failures,
and Retry-After. Tests use temporary storage and make no live HTTP requests.

Files: `sites.ts` configuration; `http.ts` budget/transport/robots; `parse.ts` extraction;
`worker.ts` scheduling; `store.ts` persistence/metrics; `cli.ts` process controls.
Set `CRAWLER_DATA_DIR` in the process environment to change storage; `.env` is not auto-loaded.
Do not run multiple instances with different data directories against the same sites:
their independent request budgets would add together.

## v1.0: public observability

Dashboard: https://exa-crawler.34.68.179.149.sslip.io

The dashboard and read-only API run in a separate `exa-observatory` systemd service.
The existing `exa-crawler` service and its database are unchanged. Caddy serves HTTPS
and proxies to the API on loopback port 4318. Google Cloud ingress exposes only
80/443 for this dashboard; SSH remains restricted to IAP.

- Overview: heartbeat, fresh articles, publisher-derived delay, request volume, site health.
- Request log: cursor pagination, site/error filters, HTTP outcomes and duration.
- Inspector: candidate links reconstructed from compressed discovery responses.
- Articles: title search, site/fresh filters, publication evidence and source links.
- Schedule: earliest source eligibility, successful polls, errors, URL discovery counts.

UI updates every 10 seconds; overview queries are cached for 10 seconds. All times
render in the viewer's local timezone. Headline metrics and the activity chart cover
all sites; the website selector filters tables and lists. Site health reflects the
last result for each discovery source, not a guarantee of complete article coverage.
The request inspector uses the current parser, shows at most 200 candidate links,
and does not claim they were all newly discovered in that poll. API responses omit
raw headers and full article bodies. Filters never make upstream requests.

`deploy/` contains the service, HTTPS configuration, and VM installation script.
The v1.0.0 deployment scripts install at `/opt/exa-observatory/v1.0.0`; the existing live database
is read at `/var/lib/exa-crawler/data/crawler.sqlite`. The public hostname uses the
VM's reserved regional IP via sslip.io; a custom domain can replace it in Caddyfile.

Publishing a Git tag does not update the running VM. Deploy this release separately
to activate v1.0.0; the existing v0.2.0 service continues until then.

Useful API endpoints: `/api/overview`, `/api/requests?domain=bbc.com`,
`/api/requests/123`, `/api/articles?fresh=true&q=news`, `/api/sources`.
There are no write endpoints. API traffic is capped globally at 300 requests/10s,
with at most two simultaneous saved-response inspections.

Validation: `npm run check`, `npm test`, `npm run dashboard:build`.
