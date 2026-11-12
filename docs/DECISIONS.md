# Layout decisions

- Keep two systemd processes: crawler and dashboard/API. Python remains an ephemeral child.
- Keep the existing root Node package and separate dashboard package; no new workspace tooling.
- Share pure parsing/policy/types through `packages/core`. Pipeline folders expose library facades; the crawler still executes parsing inline. No service-to-service source imports.
- Keep scheduling and article mapping interleaved in `crawler/src/loop/worker.ts`. Splitting it would exceed a moves-only change. The `mapper` folder is intentionally deferred.
- Keep schema creation and shared crawler queries together in `packages/db/src/store.ts`. There were no separate migrations to move. Dashboard queries keep their separate read-only connections.
- Keep existing `/api/health`, not a new `/healthz` URL. Keep Caddy/systemd, not new Docker/compose tooling.
- Keep working directories at the repository/release root, preserving relative `data` and `logs` semantics.
