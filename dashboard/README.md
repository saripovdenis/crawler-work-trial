# Crawler Observatory

React, Vite, shadcn/ui (Base UI), and Recharts. Public, read-only crawler telemetry.

From the repository root:

```sh
npm run dashboard:api
npm --prefix dashboard ci
npm --prefix dashboard run dev
```

Vite proxies `/api` to localhost:4318. Production builds are served by the API:

```sh
npm run dashboard:build
npm run dashboard:api
```

The API reads `CRAWLER_DATA_DIR/crawler.sqlite` and compressed response snapshots.
No credentials, raw response headers, full article bodies, database downloads, or
crawler controls are exposed. Filters and request inspection only read stored data;
they do not trigger extra website requests.
