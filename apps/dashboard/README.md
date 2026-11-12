# Dashboard

From repository root:

```sh
npm --prefix apps/dashboard ci
npm run dashboard:build
CRAWLER_DATA_DIR=/path/to/data npm run dashboard:api
```

One Node process serves the built UI and read-only API on `127.0.0.1:4318`.
Existing overrides: `HOST`, `PORT`, `DASHBOARD_DIST`, `CRAWLER_DATA_DIR`.
`src/pages` holds UI pages; `src/api` serves HTTP; `src/metrics` owns read-only SQLite connections.
Health: `/api/health`. Frontend development: `npm --prefix apps/dashboard run dev`.
