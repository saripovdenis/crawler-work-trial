# Coverage iteration, 12 November 2026

Previous working version was pushed as `96c7386` before starting this iteration.

## Baseline

Read-only production snapshot at 08:44 UTC: last-hour first-observed sample was
253 / 1,216 (20.8%). Recomputed on provider publication time: 172 / 825 (20.8%).
Conservative publisher-suffix normalization gives 195 / 817 (23.9%) on that same
snapshot. This is a matching correction, **not** new crawler coverage. The initial
50% target still requires live measurement after the discovery fixes run.

## Verified causes and changes

- Sina made 439 robots requests in an hour, repeatedly following a redirect
  chain that ended in HTML. Failed robots origins now back off durably for an
  hour. Healthy origins remain eligible; no robots denial is bypassed.
- One truncated Antara RSS response kept parsing pending and blocked the entire
  domain. Only complete RSS items are recovered, the poll is labeled partial,
  conditional caching is cleared, and other tasks can run while an archive retries.
  A restart revisits failed archives without another network request.
- Candidate queue scans and parsing ran on every claim. Eligibility now checks
  the unchanged persistent budget first; claims use the existing candidate index
  and active-lease index. Parsing runs one archive at a time after completion or
  on the recovery timer. Downloaded tasks remain unavailable until processed.
- Generic source discovery favored archives and the first six robots sitemaps.
  News/recent feeds now rank first. Existing archive maps poll at most every six
  hours; new archive/category/video maps are not added as news sources.
- Added BBC's advertised news sitemap, Sina's finance/news homepages, and the
  Times of India/Economic Times homepages. They use ordinary robots checks and
  the existing domain-wide request ledger. External article URLs are never seeded.
- Coverage defaults to the last publication hour, preserves separate observation
  times, exposes unknown-date exclusions, and shows Google-only/Exa-only/shared
  counts. Known publisher suffixes no longer prevent exact title/date matching.
  Probable matches remain labeled; ambiguous titles remain unmatched.

No budget limits, dispatch deadlines, schema, stored article history, provider
caps, ports, or public URLs change. External audit responses still cannot create
crawler articles. The Python worker keeps its current deployed version.

## Verification

Tests use synthetic responses and a database copy. The actual truncated Antara
archive recovers 19 complete entries and excludes the truncated final entry.
The production-size coverage query takes about 86 ms locally; VM latency differs.
All 49 tests, typecheck, boundary check, frontend build, and simulated two-process
startup/restart passed. Desktop and 390px mobile layouts were checked with no console errors.
The startup check was fixed to wait for a new processed request rather than a
historical row before stopping its worker. Live results must be reported
separately from the baseline correction above.

## Follow-up corrections

Repeated HTML links now leave the initial sample queue while preserving their
original discovery time. Previously, many URLs first seen during an initial poll
remained priority zero forever, even when the homepage kept showing them.

CE's `publishdate` metadata and Eastmoney's article-header date now have explicit
+08:00 site profiles. Page-generation comments are not publication evidence.
`services/pipeline/src/extract/repair-publication.ts` can repair missing dates
from verified archived article responses, with dry-run default and a write-ahead
before/after audit. It preserves fetch/discovery times and article content.

UDN's recognized referral parameters no longer defeat direct URL matching.
Haberturk's singular/plural local-news suffixes are normalized consistently.
Known topic/profile URLs are excluded with their reason and link visible in the
API and dashboard; `unfilteredSummary` preserves the original denominator.
Unknown result types, including Google wrappers, still count. Some provider
results are navigation pages rather than newly published articles, so this
sample is not a validated census of all news articles.

Follow-up validation: all 59 tests, typecheck, boundary check and frontend build pass.
The archive repair was also applied to a local database copy: four available
archived responses repaired, with original timestamps preserved.

## Seven-point live audit follow-up

1. Chosun Fusion JSON supplies missing article text; CE/Eastmoney publisher date
   profiles supply missing date evidence. Archive repair preserves original
   timestamps, recalculates fingerprints, and retains a reversible audit.
2. Source scheduling measures new complete articles, slows empty alternatives,
   admits current news maps ahead of archives, and adds Sina rolling lists.
3. Parsing uses an in-process worker thread; mapping yields every 100 rows.
   Dispatch latency and internal deadline failures are visible separately.
4. Every fifth article assignment serves the oldest eligible positive-priority
   candidate; other assignments prefer recent publication evidence.
5. Failed robots origins back off; successful source redirect destinations persist
   and revert to the original URL if the destination later disappears.
6. Oversized and unsupported sources back off for six hours while useful sources
   continue. Partial RSS recovers only closed items and clears validators.
7. Coverage reports matched-and-complete separately, including per-domain counts;
   URL/title evidence and provider-sample limitations remain visible.

Validation: 77 tests passed, plus typecheck, boundary check, frontend build,
production-copy process startup/restart, and desktop/mobile UI checks. Tests use
archives/simulators, never publisher requests. Source-yield attribution can
conservatively miss canonical aliases; quiet sites retain normal polling.

Status reporting also groups article counts once rather than scanning the table
40 times. Counts matched exactly on the production copy (158 ms versus 3.5 ms
locally), reducing startup and heartbeat work without a schema change.

The archive-repair receipt lookup now loads one batch index instead of rescanning
request history per article. It selected identical request IDs for 200 production-copy
records (566 ms versus 16 ms locally); four repair tests pass. The first production
dry-run found 183 repairable records out of 200; unproven text/dates remain flagged.

Further CPU checks found redundant Readability work when structured text, title,
and description already supply every output. Skipping it produced identical
fields on six archived controls (about 3–9 ms instead of 26–133 ms locally).
Initial-sample eligibility now stops counting at eight, preserving the same
selection decision while avoiding scans of thousands of completed candidates.
