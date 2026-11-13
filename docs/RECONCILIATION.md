> Current provider policy: Google News and Exa are available on Coverage,
> Freshness and Crawler-only. Google is the default; `?provider=exa` selects Exa.
> Each provider polls every site hourly. Exa uses Lite search, up to 100 results,
> with no article contents or summaries. All coverage numbers describe the
> selected provider's deduplicated sample, never total publisher output.

# External coverage reconciliation

> Deployment policy: only current `master` through
> `sudo /usr/local/sbin/deploy-exa-master`. Release-path commands below describe
> historical deployments and are retired. See [deployment documentation](../deploy/README.md).


`services/monitor` runs independently of the crawler and dashboard. It polls each
configured domain every hour, staggered by six seconds per provider. Two
bounded request slots prevent one slow provider from blocking all others. A slow
round can finish late; the dashboard exposes each call and its timestamps.

## What the percentage means

**Matched fetched articles / unique articles in the external provider sample.**
It is not total website coverage. A provider may miss stories, index late, return
old articles or truncate a busy domain. No external sample means no percentage,
not 100%. The combined sample deduplicates providers. The per-provider columns
show how many unique external articles each contributed, not independent truth.
Google-only + Exa-only + shared equals the combined sample. Each shared group
retains both provider records and timestamps. Different indexing, ranking, locale
and result caps explain different samples; neither provider is ground truth.

Fetched coverage uses archived HTTP 200 article requests with no fetch error,
whether parsing has finished, is pending, or has failed. Redirects, failed or
unfinished downloads, discovery requests and external audit requests do not count.
Parsed `articles` rows enrich these downloads with canonical URLs, titles and
quality; they are not required for a URL match. `summary.unparsed` counts matched
downloads without a parsed record; `summary.incomplete` counts incomplete parsed
records. Neither counts toward “matched & complete.”
Google wrapper URLs still need a probable title/date match (or grouping with an
identified provider URL), so a Google-only item can remain unmatched until parsing.

Both coverage cards and each domain row use the same external-sample denominator:
`fetchedMatched / total` and `parsedMatched / total`, with percentages exposed as
`fetchedPercentage` and `parsedPercentage`. Parsed counts include incomplete
records; `completeMatched` / `completePercentage` show the complete subset.
The existing `matched` and `percentage` fields remain aliases for fetched coverage.

Matching uses a normalized URL first (tracking parameters, fragments, `www`,
scheme and trailing slash removed). Otherwise an exact normalized title (with recognized terminal publisher branding removed), same
configured domain and publication times within six hours can give a **probable**
match only when exactly one fetched article qualifies. Ambiguous titles do not
match. Google wrapper URLs are never followed: Google is matched by title/date.
This heuristic can miss changed headlines and confuse repeated headlines; URL
and probable-title counts are shown separately.

When the exact title finds nothing, the relaxed title rules below are tried in
order. None scores similarity: each names one exact difference between the two
titles. All require the same domain, publication times within three hours and a
single story.

| `match_rule` | The provider title and the article title differ only by |
| --- | --- |
| `same_story` | nothing, but the crawler holds several copies published within 10 minutes (for example `www` and `biz` hosts); the earliest fetch is used |
| `short_title` | nothing, but a Chinese, Japanese or Korean title is shorter than the 12-character minimum (6 applies to those scripts) |
| `normalized` | spacing, punctuation or HTML entities |
| `alternate_title` | the page having two titles: the provider shows `og:title`, the parser stored the headline |
| `section_trail` | a trail after the headline, as in `Headline \| Section \| Site`; the headline must be at least half of the title |
| `cut_short` | one side being cut at a length limit: it is at least 60 characters (20 for those scripts) and the other starts with all of it |

Copies published further apart stay ambiguous and unmatched. `summary` reports
`exactTitleMatched` and `relaxedTitleMatched` inside `titleMatched`, and every
group carries its `match_rule`. Matching runs when a page is read, so earlier
hours are scored by the current rules.

All of this lives in `packages/reconciliation/src/matching/`: `rules.ts` holds
every threshold and an on/off switch per rule, `titles.ts` the compared title
forms, `title-index.ts` the rules in order, `content-kind.ts` the non-article
page shapes. The readers call only `matchSightings`, `attachAlternateTitles`
and `groupContentKind`.

The default window is the last **publication hour**. The 10m/1h/24h/7d selector uses
`external_sightings.provider_published_at`, not first observation. Old stories
newly indexed today no longer enter the last-hour sample. Unknown publication
dates are excluded and counted explicitly. First/last observations and each
provider's original timestamps remain available in the timing details. All times
are UTC. Publication is provider-reported, not proof of freshness or indexing time.

The last-10-minutes view is provisional: the provider polling interval is
one hour, and indexing delays or later polls can change the sample. Selecting
it only reads stored data; it does not trigger calls or consume provider quota.
The default remains one hour.

New unmatched items receive a 30-minute grace period. Afterwards they appear as
“Not matched,” not as proven misses. Filters and 30-second UI refreshes only read
saved data. The API caches results for 15 seconds, limits comparison to 50,000
sightings (flagging truncation) and paginates articles in groups of 50. `matches=all|matched|unmatched` and `page=1..1000` select the article list without changing summary counts.

## Providers and limits

| Provider | Credential | Request | Default lifetime cap |
|---|---|---|---|
| Google News | none | unofficial RSS search, typically max 100 | none |
| Exa | `EXA_API_KEY` | Lite search, max 100 results, no content fetching | none |

Search caps mean **sampling**. Full pages are marked truncated; a full page does
not establish the provider's total count. Per-poll counts, original publication
and first observation times, URLs and titles remain stored. Overlapping polls
are deduplicated before coverage is calculated. Results are filtered to the
exact publication window locally. The lookback overlaps the previous success by
one hour, capped at 24 hours after an outage. Google uses rounded-up hours.

20 domains × 24 polls/day = **480 calls/day/provider**. Both providers retain a
secondary default cap of 3,000 calls per rolling 24 hours, allowing their old
10-minute history to drain without resetting the quota ledger. The persisted
per-site schedule enforces the hourly cadence, including after a restart.

Exa additionally has a **$45.12 rolling daily spend cap**. Before reserving a new
call, its maximum $0.094 charge must fit. Reported `cost_usd` is used for completed
calls; missing costs, failed and in-flight calls conservatively count as $0.094
per charged request. The reservation and budget check happen in the same claim
transaction. This uses the existing ledger, including earlier trial spend, and
requires no schema change. Costs in other applications are not visible here.

At the checked Lite rate ($0.004/search plus $0.001 per result above ten), a full
100-result search costs $0.094. 480 full searches cost $45.12/day. No content or
AI summaries are requested. `config/monitor.ts` holds the mode, result cap and
cost ceilings together; verify pricing before changing them.

`MONITOR_<PROVIDER>_DAILY_LIMIT` and `MONITOR_<PROVIDER>_TOTAL_LIMIT` can further
restrict requests. Zero daily limit disables calls; zero total limit removes
the lifetime cap. The old default 1,000-call Exa trial cap is removed. History is
retained, not reset. A missing key disables Exa; authentication or credit errors
pause it. No payment method or automatic top-up is configured by this change.

Reservations commit to PostgreSQL **before** sending. Failed and interrupted calls
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
Unknown filters return 400. `/reconciliation` is the public dashboard page; it reads
`GET /api/summary`, which derives the 10m, 1h and 24h figures (fetched coverage and
publication-to-fetch P50/P90, overall and per domain) from one cached 24-hour dataset.
A group falls in a window by its earliest provider publication, so the 24-hour figures
equal `/api/reconciliation?window=24h`.

Production: credentials live in `/etc/exa-reconciler.env` (root-owned 0600); deploy with the master
command in [deploy/README.md](../deploy/README.md). The existing worker, Caddy, ports and URLs remain unchanged.
The scheduler/API each restart once by default. Pass `--dashboard-monitor-only`
for monitor/UI-only changes: restart only the dashboard and reconciler, preserving
scheduler and worker PIDs. Both SQLite databases are backed up first.
No migration or budget reset is needed.
Roll back by restoring the saved units in the release's `deploy/previous-units`
and restarting them; stop the reconciler if reverting the feature entirely.

Automated suites were removed by project preference. Manual provider calls consume
quota and remain recorded in the provider ledger; avoid them for routine validation.

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
hourly cadence bounds polling resolution but does not establish exact index-entry time.

Matched groups expose:
- `crawler_fetch_finished_at`: `attempt_assignments.completion.finished_at` from
  the worker, linked through its successful article request and original task URL.
  This excludes redirects, failed requests and audits, but includes pending parses. Legacy
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

Restarting preserves provider cooldowns and six-second spacing. Due times are
advanced when necessary to last charged attempt + one hour. Neither a restart
nor the move from ten-minute polling can trigger an early repeat.

Coverage and Freshness cache by provider. Switching the selector changes all
three time-window cards and every domain row together; old-provider values are
hidden while the requested provider loads. An aborted response cannot replace
the selected provider's data. Loading, errors and quota status remain visible.

## Result types and archived date repairs

The API exposes `excludedNonArticles`, `excludedGroups` (URL and reason), and
`unfilteredSummary`. Only known El Mundo topic/byline routes, Mediapart
profile/listing routes and Sina comment pages are excluded. Unknown URLs stay in
the sample. The dashboard's expandable exclusions list makes this reviewable.

A Google wrapper link hides the page URL, but Google's feed names each row's
source host. The monitor stores it in `external_sightings.source_host`, and a
row whose source is `comment5.news.sina.com.cn` is a comment thread, not an
article. A group is excluded only when every row in it is such a page, whether
or not it matched. Rows collected before the column existed have no host and
stay in the sample; a row seen again by a later poll gets its host filled in.
The host list is `nonArticleHosts` in `matching/rules.ts`.
UDN referral parameters are removed only for recognized `udn-`/`udn_` values.

Missing CE/Eastmoney publication dates can be repaired without HTTP:

```sh
node --import tsx services/pipeline/src/extract/repair-publication.ts \
  --db /path/crawler.sqlite --data-dir /path/data --hours 3 --limit 500
# Add --apply --audit /path/new-audit.jsonl to write reviewed repairs.
```

Only successful, processed article archives with verified hashes qualify. The
command preserves original fetch/discovery times and content, uses the same
publication profile and classification function as the parser, and skips
concurrent changes. Its before/after audit allows conditional rollback.

## Complete coverage and dispatch health

`/api/reconciliation` reports fetched matches and **matched & complete** separately, both overall
and by domain. `completeMatched` / `completePercentage` exclude
`classification='incomplete'` rows. URL and probable title matches remain
separate. Historical UDN referral keys are normalized when read as well as on
new sightings.

`dispatch` contains last-hour assignment-to-reported-worker-start p50/p95/max,
internal deadline failures, completed attempts without a reported start, lease
expiries and counts by transport. This distinguishes internal dispatch failures
from publisher HTTP responses. It does not claim that worker start equals TCP send.

Archive repair also supports incomplete Chosun articles. It extracts JSON story
text without executing scripts, preserves original fetch/discovery timestamps and
known publication dates, and updates fingerprints/classification. Use `--hours 168`
for the whole trial, process bounded batches, then pass `--cursor` from the returned
`nextCursor` with a fresh audit filename until `truncated` is false. Empty verified
story bodies stay incomplete. SQLite/API are authoritative; old append-only JSONL
exports remain historical observations.

Repairs also store `reprocessedAt` in the article payload, exposed as
`crawler_reprocessed_at` in timing details. This records the repair-run start separately from the original fetch and first parse;
individual rows are corrected during that run.

## Crawler-only view

`/crawler-only` reverses the Coverage comparison: which parsed article records
are absent from the stored provider samples? It reads the existing databases;
viewing or refreshing it makes no provider requests and spends no Exa quota.

The page shows one percentage and a domain breakdown against Google News.
The percentage is `crawlerOnly / compared * 100`. For 24-hour and seven-day
windows, `compared` includes articles at least 120 minutes old that are either confirmed listed or absent
from a successful covering sample. Pending, uncertain and non-comparable
records are excluded; an empty denominator returns `null`, displayed as “—”.
Both capped and uncapped samples count, so this is sampled absence, not proof
of exclusivity. The page also offers “Last hour · provisional”: the literal latest 60 minutes
by publication time, without the 120-minute grace. A confirmed match or a
successful covering poll is still required; uncertain matches stay excluded.
This is absence from available samples so far, and may change as Google indexes
articles. The API exposes `provisional: true` and `gracePeriodMinutes: 0` for
`window=1h`. The 24-hour and seven-day windows retain the 120-minute grace.

`GET /api/crawler-only?window=24h&site=&provider=google&show=all&page=1`
accepts publication windows `1h`, `24h` (default) and `7d`; a configured site;
providers `both`, `google` (default) or `exa`; and status filters `all`, `crawler_only`,
`listed`, `pending`, `possible`, `strong`, `weak` or `not_comparable`.

The population contains parsed records with a valid publication date inside
`[windowStart, windowEnd)`, including incomplete parses. Undated parsed records
and downloads without parsed records are excluded because their publication
window cannot be established. `population.undatedExcluded` and
`population.unparsedExcluded` report these site-scoped diagnostic counts across
all available history; they are not added to the window's totals.

Each provider is assessed independently using Coverage's `matchSightings` and
the same fetched-article inputs. Google wrappers do not become publisher URL
matches. Google comparison therefore uses the existing exact normalized-title,
unique-candidate and publication-time rules. A same-title row that fails that
matcher remains possible evidence, never a confirmed match.

| Status | Rule, in precedence order |
| --- | --- |
| Not comparable | No saved successful crawler fetch exists for the parsed record. |
| Listed | At least one selected provider has a stored matched row. |
| Provider may still list it | Unlisted and published less than 120 minutes ago. |
| Possible match | Unmatched, but a selected provider has the same normalized title. |
| Not comparable | Any selected provider lacks a successful poll covering publication. |
| Crawler-only, weak | A selected provider's latest successful covering poll was capped. |
| Crawler-only, strong | Every selected provider's latest successful covering poll was uncapped. |

The 120-minute grace is the shared 60-minute lookback plus 60-minute cadence.
Covering evidence always uses each run's actual `window_start <= publication <
window_end`, successful status and completed observation time. Failed polls
never support a strong or weak claim. Each row exposes the selected providers' status, reason and last successful
covering poll, including its cap flag. Unselected providers are marked as such;
the reader only matches sightings from selected providers.

API status and domain counts are exact over the whole population. `listed + possible
+ strong + weak + pending = comparable`; `notComparable` is separate. Listed
Google-only, Exa-only and both are mutually exclusive for the selected providers.
Domain poll cap shares use successful polls whose stored windows overlap the
selected window; failures are reported separately.

Only the newest 2,000 detailed rows are retained per cached dataset. Status
filtering and pagination then operate on those retained rows, 50 per page.
`groupCount` is the exact count for the selected status; `rowCount` and
`pageCount` describe retained rows. Truncation is explicit: narrowing the window
or site can expose older matching rows. Pagination/filter changes reuse the
same 60-second dataset cache and its original timestamps, with the dashboard's
five-minute stale limit.

**Absent from the 10-minute sample is not proof the provider lacks the article.**
Capped ranking samples, failed polls, indexing delays and ambiguous titles all
limit the comparison. Even strong means absent from an uncapped stored sample,
not proven absent from a provider's full index.
