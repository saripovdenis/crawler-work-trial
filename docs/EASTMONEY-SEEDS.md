# Eastmoney live discovery

The global (column 102) and stock live JSON feeds use `eastmoney-live` and poll
every 180 seconds. Each reads the latest 100 entries. The HTTPS yaowen fallback
polls every 15 minutes; cgnjj is no longer a configured seed. Existing source
rows remain subject to the normal non-seed policy.

`req_trace=0` is the stable configured identity. Before reserving a request,
the scheduler replaces it with the current millisecond timestamp. The actual
URL is recorded in both the durable request ledger and worker assignment.
All requests, including robots and redirects, share Eastmoney's 3/minute limit.

The adapter validates the response and string article IDs, deduplicates URLs,
and flags malformed rows as partial. It does not treat feed `showTime` as a
verified publication date. Normal fetch completion remains discovery time.
Raw responses are archived through the existing worker.

Historical `sortEnd` cursors are intentionally not registered as recurring
sources. Catch-up pagination and recovery of expired candidates remain separate
work. Bursts exceeding 100 entries between polls can still cause omissions.

Read-only research on 2026-11-13 found 36 of 82 Exa sample misses in these feeds
(22 undiscovered, 14 expired) and 244 unmatched Google title candidates. These
are opportunities, not measured coverage gains. Compare complete fetched
matches, feed yield, delays and queue expiry after deployment.
