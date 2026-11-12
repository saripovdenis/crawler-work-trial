# External reconciliation monitor

Run `npm run monitor` from the repository root. It loads optional `.env.monitor`
credentials, reserves provider quota in `RECONCILER_DB`, and polls every 30 minutes.
It has no HTTP server and does not contact publisher sites. The dashboard reads
its database separately; only the crawler scheduler may execute audit tasks.

See [configuration, coverage semantics, limits and deployment](../../docs/RECONCILIATION.md).
