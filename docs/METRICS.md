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

## Publication-to-fetch delay

Freshness shows P50/P75/P90 of **successful download finish minus the earliest
publication date reported by Google News or Exa**. One provider is enough; an
article does not have to appear in both. Provider observation times are not part
of this metric. It measures download completion, not parse completion.

The page shows the P50 (with P90 and the sample size) for 10 minutes, 1 hour and
24 hours, overall and per domain, from `/api/summary`. That endpoint derives all three
windows from the 24-hour coverage dataset, so it does not reach provider records older
than 24 hours the way `/api/freshness` does. `/api/freshness` keeps the per-URL table:
every row exposes its earliest publication, the provider(s) reporting that date, linked
fetch finish, delay and status. Missing downloads or timestamps never become zero.
Incomplete parses and probable title matches remain included.

The read-only `/api/freshness` retains its existing fields and adds
`groups[].publication_timing` with `publishedAt`, `providers`, `fetchFinishedAt`
and `delayMs`. The same helper supplies table values and percentile inputs.
`freshness.overall.published` contains the three nearest-rank percentiles.

Windows (`10m`, `1h`, `24h`, `7d`) use each article's earliest known provider
publication. Freshness groups historical provider records before applying the
window, so an older date outside the window is not lost when the other provider
reports a newer date. The existing 50,000-record query cap remains; truncation is
flagged. Coverage's separate window behavior remains unchanged.

This is a sample of provider-reported articles, not all crawler downloads or a
complete census. Negative delays remain visible as timestamp anomalies. All times
are UTC; polling, quotas, database schemas and crawler behavior are unchanged.
The prior comparison fields remain in the API for compatibility but are not shown
on the page.
