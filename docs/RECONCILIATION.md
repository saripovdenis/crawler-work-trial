# External coverage reconciliation

`services/monitor` runs independently of the crawler and dashboard. It polls each
configured domain every 10 minutes, staggered by six seconds per provider. Two
bounded request slots prevent one slow provider from blocking all others. A slow
round can finish late; the dashboard exposes each call and its timestamps.

## What the percentage means

**Matched fetched articles / unique articles in the external provider sample.**
It is not total website coverage. A provider may miss stories, index late, return
old articles or truncate a busy domain. No external sample means no percentage,
not 100%. The combined sample deduplicates providers. The per-provider columns
show how many unique external articles each contributed, not independent truth.

Only rows in the crawler's `articles` table count as fetched. Pending candidates
and failed requests do not count. Incomplete parsed articles do count as fetched;
`summary.incomplete` reports them separately. Parsing quality remains on Charts.

Matching uses a normalized URL first (tracking parameters, fragments, `www`,
scheme and trailing slash removed). Otherwise an exact normalized title, same
configured domain and publication times within six hours can give a **probable**
match only when exactly one fetched article qualifies. Ambiguous titles do not
match. Google wrapper URLs are never followed: Google is matched by title/date.
This heuristic can miss changed headlines and confuse repeated headlines; URL
and probable-title counts are shown separately.

The selected 1h/24h/7d window uses `external_sightings.observed_at`: when this
monitor first saw the item at that provider. It is not publication time or proof
of when that provider first indexed it. Only publication fields are used
for title matching. All persisted timestamps and display times are UTC.

New unmatched items receive a 30-minute grace period. Afterwards they appear as
“Not matched,” not as proven misses. Filters and 30-second UI refreshes only read
saved data. The API caches results for 15 seconds, limits comparison to 50,000
sightings (flagging truncation) and paginates articles in groups of 50. `matches=all|matched|unmatched` and `page=1..1000` select the article list without changing summary counts.

## Providers and limits

| Provider | Credential | Request | Default lifetime cap |
|---|---|---|---|
| Google News | none | unofficial RSS search, typically max 100 | none |
| Exa | `EXA_API_KEY` | search only, 10 results, no content fetching | 1,000 calls |

Only Google News and Exa are scheduled. Previously configured providers remain
disabled; their historical quota records are retained. No account signup is needed.
Search caps mean **sampling**. Exa deliberately requests ten results to keep
cost down; it is not a complete per-domain benchmark. Full pages are marked
truncated even when the provider cannot confirm that more results exist.
Results are filtered to the exact publication window locally.
The lookback overlaps the last success by one hour, capped at 24 hours after an
outage. Google uses a rounded-up hour lookback and remains best effort.

20 domains × 144 polls/day = **2,880 calls/day/provider**. Exa's 1,000-call cap
lasts about 8 hours 20 minutes from zero usage and protects this initial trial; it does not automatically buy more credits. Current account quotas and
pricing must be checked before raising these limits.

Daily defaults are 3,000 Google calls and 1,000 Exa calls per rolling 24 hours. Override with
`MONITOR_<PROVIDER>_DAILY_LIMIT` or `MONITOR_<PROVIDER>_TOTAL_LIMIT`, where PROVIDER
is `GOOGLE` or `EXA`. A zero daily limit disables
calls; a zero total limit means no lifetime cap. Lifetime usage counts all
reservations in this database, including across key rotation. It is not the
provider's account balance; usage by other apps is unknown.

Reservations commit to SQLite **before** sending. Failed and interrupted calls
remain charged, even if they never reached the provider. Restarts preserve due
times and usage. HTTP 429/503 honors Retry-After; paid-provider 401/402/403 pauses
that provider until configuration/restart. There is no automatic pagination or
hidden retry. Provider bodies and credentials are not logged. Exa's reported
`costDollars.total` is retained in the run ledger when available.

## Storage and request boundaries

`RECONCILER_DB` defaults to `data/reconciler.sqlite`; production uses
`/var/lib/exa-crawler/reconciliation/reconciler.sqlite` on the existing data disk.
It contains provider schedules, call reservations/results, external sightings,
heartbeat and an audit inbox. This is a separate schema; the crawler schema and
existing data paths are unchanged. Back it up with SQLite backup, not an active
main-file-only copy. Do not delete it to redeploy: that would erase quota history.

Only `services/monitor/src/client.ts` may send provider requests. It permits
exact HTTPS provider hosts and paths, refuses publisher domains and redirects,
and bounds response size/time. All other server-side HTTP remains restricted
to the crawler's fetcher. The monitor never writes the crawler database.

The scheduler reads the audit inbox on a separate read-only connection every
30 seconds when `RECONCILER_DB` is configured. After the grace period it skips
already-fetched or exact pending URLs, then inserts durable `purpose='audit'`
tasks with low priority. An audit starts only when no regular task is eligible,
at most once per hour/domain. Robots, redirects, cooldowns and each HTTP attempt
use the existing persistent site budget. Audits can therefore remain queued on
busy sites. Completion archives the response and records the request; it never
inserts an article, candidate, discovery or fresh-article export. This prevents
verification from improving the measurement it is supposed to check. The page
shows imported audit status when available.

## Run and deploy

```sh
# Save credentials in git-ignored .env.monitor, mode 0600.
npm run monitor
# Run the existing dashboard with the SAME RECONCILER_DB value.
RECONCILER_DB=data/reconciler.sqlite npm run dashboard:api
# Optional budgeted audit consumption by the scheduler:
RECONCILER_DB=data/reconciler.sqlite npm run scheduler
```

`GET /api/reconciliation?window=24h&site=bbc.com&provider=exa` is read-only.
Unknown filters return 400. `/reconciliation` is the public dashboard page.

Production: run `npm test` and build the frontend locally, then upload a clean release plus its dist,
install credentials in `/etc/exa-reconciler.env` (root-owned 0600), then run
`sudo bash deploy/deploy-reconciler.sh /opt/exa-crawler/reconcile-COMMIT`.
The script preserves active unit settings, updates scheduler/API code, and adds
`exa-reconciler`. The existing worker, Caddy, ports and URLs remain unchanged.
The scheduler/API each restart once by default. Pass `--dashboard-monitor-only`
for monitor/UI-only changes: restart only the dashboard and reconciler, preserving
scheduler and worker PIDs. Both SQLite databases are backed up first.
No migration or budget reset is needed.
Roll back by restoring the saved units in the release's `deploy/previous-units`
and restarting them; stop the reconciler if reverting the feature entirely.

Tests use saved/synthetic provider responses, mock transport and SQLite copies;
no test contacts a publisher. Tests cover destination/redirect refusal, all
provider shapes, time filtering, restart quotas, matching, empty samples, audit
provenance/budgets and API filters. Live provider smoke tests are charged and
retained in the same ledger shipped to production.

Source: [Exa search](https://exa.ai/docs/reference/search).
Google RSS is unofficial and may change.

## Article timing API

`GET /api/reconciliation?window=24h&matches=matched&page=1` returns saved evidence;
it does not call a provider. `groups[].provider_timings[]` retains each provider's
own `sighting_id`, `url`, `published_at`, `observed_at`, `last_observed_at`,
`first_run_id`, `first_poll_started_at`, and `first_poll_finished_at`. Publication,
first observation and first run are immutable after insertion; repeated polls only
advance last observation. Existing historical sightings already contain this evidence.
No provider payload or API key is sent to publishers.

Neither current provider adapter supplies exact index-entry time:
`provider_first_seen_at` stays null. `observed_at` is an upper bound on when the
provider had that item, not proof it appeared since the previous poll. Ranking,
truncation, errors and indexing delays make absent results inconclusive. The
10-minute cadence improves observation resolution but does not guarantee it.

Matched groups expose:
- `crawler_fetch_finished_at`: `attempt_assignments.completion.finished_at` from
  the worker, linked through its successful article request and original task URL.
  This excludes redirects, failed requests, audits and pending parses. Legacy
  requests use `requests.finished`, labeled `legacy_request_finished`; missing
  evidence stays null. The durable scheduler's `requests.finished` is receipt
  arrival time and is deliberately not used as network finish.
- `crawler_parsed_at`: `articles.fetched`, when parsing was recorded.
- `crawler_published_at`: publication parsed from the article.
- `crawler_discovered_at`: the existing crawler discovery field, unchanged.
- `crawler_request_id` and `crawler_fetch_time_source`: traceable provenance.

Each provider timing includes `fetch_minus_published_ms` and
`fetch_minus_observed_ms`. They are signed, null when either timestamp is unknown,
and are not a claim about which index was faster. All API times are UTC epoch
milliseconds; the UI renders UTC. Title matches remain explicitly probable.

At the currently documented $7 per 1,000 auto searches, an uncapped 10-minute
Exa schedule would cost about $20.16/day. The 1,000-call lifetime cap is unchanged;
this change does not enable purchases or reset charged calls. Google has no
paid key here; RSS availability remains best effort. On restart, persisted due
times are shortened to no later than last charged attempt + 10 minutes, preserving
cooldowns and the six-second spacing between calls.
