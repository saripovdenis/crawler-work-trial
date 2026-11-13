# External reconciliation monitor

Run `npm run monitor` from the repository root. It loads optional `.env.monitor`
credentials, reserves provider quota in PostgreSQL, and polls each site hourly.
Google News and Exa share the comparison UI. Exa uses Lite search with up to
100 results, no article contents, and a $45.12 rolling daily spend cap. Unknown
costs reserve $0.094 per call; existing spend is retained. The hourly schedule
permits at most 480 new calls per day across 20 sites.
It has no HTTP server and does not contact publisher sites. The dashboard reads
its database separately; only the crawler scheduler may execute audit tasks.

See [configuration, coverage semantics, limits and deployment](../../docs/RECONCILIATION.md).
