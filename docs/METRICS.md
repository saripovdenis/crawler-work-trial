# Existing metric semantics

No metric changed during the layout move.

- Parsing quality counts persisted `articles.classification = 'incomplete'`, assigned by
  `packages/core/src/policy.ts`. The dashboard does not reclassify articles.
- Window membership uses `articles.fetched`, written after parsing finishes.
  Pending candidates and fetch failures are excluded. Grouping uses configured domains.
- Six lookback windows: 5m, 30m, 1h, 3h, 1d, 1w. UTC boundaries, ten-second response cache.
- Empty domains have a null percentage. Overall percentage uses all parsed posts as denominator.
- Existing overview delay/coverage limitations remain documented in the root README.

With durable workers, request `finished` is the scheduler-observed completion time,
not the worker clock. Worker start/finish timestamps remain in assignment completion JSON.
This conservatively includes reporting delay in the existing request-duration metric.
Article `fetched` still records successful parse completion. Fetch completion alone does
not advance source poll counts or insert an article; durable processing must succeed.

## Freshness comparison

`/freshness` and read-only `GET /api/freshness` reuse Coverage's publication
windows (`10m`, `1h`, `24h`, `7d`), domain/provider filters, matching and exclusions.
The article timing inspector moved from Coverage to this page. No provider calls
or crawler changes are involved.

- Delay is successful **fetch completion minus provider timestamp**, in ms.
  The default is article publication → our download finish. Publication is the
  article date reported by the provider, not its indexing time. The secondary
  observation view compares our download with our own provider poll; a negative
  offset does not prove we beat the provider. Explicit `baseline=observed` links
  still open that view. Provider bars measure our crawler on different samples.
- Fetch completion comes from the existing timing resolver: worker receipt when
  available, legacy request finish otherwise. Article `fetched` is parse completion
  and is never substituted when a fetch timestamp is missing.
- p50/p75/p90 use nearest rank, `ceil(p * n)`, on sorted signed delays. Empty samples
  return null. Results cover the full filtered sample, independent of table pagination
  and its matched/unmatched filter.
- Overall and domain figures deduplicate the provider union, using the earliest
  timestamp of each kind among selected providers per article. Each provider's
  figures use that provider's timestamps only. Repeated sightings do not add weight.
- Unmatched and unknown-fetch-time records are excluded from percentiles, with
  separate counts. Incomplete and probable title matches remain included and labeled.
  This measures fetched articles, not complete-content latency or total coverage.
- First observation is an upper bound on provider availability, not exact indexing
  time. Ten-minute polling, outages and quota limits can make apparent leads larger.
- Responses share Coverage's 15-second memory cache, on a separate cache key.
  UI refreshes every 30 seconds while visible. Both databases are opened read-only.

### Shared-article timing comparison

The primary Freshness chart compares **our download completion**, **our first
Google News observation** and **our first Exa observation**. It has one row each
for P50, P75 and P90. These are elapsed times after publication, not a chart of
provider indexing speed. Provider observation can lag actual availability by a
poll interval or more. No extra provider calls are made.

`freshness.comparison` uses only articles matched to a successful crawler download
with an observation from every selected provider and at least one known publication
date. All series use that exact same cohort. Each article's baseline is the earliest
publication time reported by the selected providers. A provider-specific baseline
is deliberately not subtracted from each series: differing dates would create a
false timing advantage. Differences in reported dates, probable title matches,
incomplete parses and negative timing anomalies are counted explicitly. Missing
fetches, observations and dates are excluded with separate counts, never zero-filled.

Percentiles use nearest rank on per-article elapsed times over the full filtered
sample before pagination. They are not differences of independently calculated
percentiles. A single-provider filter compares our crawler and that provider on
their shared cohort. An empty cohort shows no percentage or timing result. The
existing crawler-only metrics remain in an expandable diagnostics section.
