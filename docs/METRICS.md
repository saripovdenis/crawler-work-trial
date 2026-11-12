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
