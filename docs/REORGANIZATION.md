# Repository move audit

Test files and harnesses mentioned below were later removed at the user's request.
See `AGENTS.md` for the current validation policy.

Baseline: `2fc8e49`. Existing files were moved with `git mv` in separate shared-code,
crawler, and dashboard commits. Tests/fixtures and deployment/docs follow separately.

## Mapping

| Previous top-level entry | Destination |
| --- | --- |
| `src/index.ts`, `cli.ts`, `worker.ts` | `services/crawler/src/loop/` |
| `src/budget.ts`, test | `services/crawler/src/scheduler/` |
| `src/http.ts`, probes, tests | `services/crawler/src/fetcher/` |
| `src/transport.ts`, test | `services/crawler/src/fetcher/transports/` |
| `src/api.ts`, `charts.test.ts` | `apps/dashboard/src/api/` (`api.ts` → `index.ts`) |
| `src/observability.ts`, test, `charts.ts` | `apps/dashboard/src/metrics/` |
| `src/store.ts` | `packages/db/src/store.ts` |
| `src/parse.ts`, `policy.ts`, `types.ts`, `core.test.ts` | `packages/core/src/` |
| `src/sites.ts` | `config/sites.ts` |
| `dashboard/` | `apps/dashboard/`; App and charts UI → `src/pages/` |
| `scripts/cffi-fetch.py`, `check-cffi.py` | `services/fetcher-impersonate/` |
| `scripts/cffi-requirements.txt` | `services/fetcher-impersonate/requirements.txt` |
| `experiments/` | `docs/experiments/` |
| `deploy/` | unchanged location, updated entry paths |
| `README.md`, `package.json`, `package-lock.json`, `tsconfig.json` | repository root |
| `.gitignore`, `.vscode/` | repository root |
| `data/`, `logs/`, `.venv/`, dependencies/build outputs (untracked) | ignored; data/log locations unchanged |

Small deviations: shared pure code also needs `packages/core`; pipeline stays a library;
mapping stays inside the worker; existing health URL remains `/api/health`; systemd/Caddy
remain instead of adding Docker. See DECISIONS.md. There is no new daemon or migration.

## Every content change beyond imports/re-exports

Paths below use the final layout. Everything else is a rename or import-path edit.

| File | Reason |
| --- | --- |
| `.vscode/launch.json` | Debugger entry path |
| `package.json` | Moved entry/test/build paths; scripts for boundary check and fixture simulator |
| `tsconfig.json` | Include moved server packages and tests, excluding browser code |
| `apps/dashboard/tsconfig.app.json` | Keep browser compilation separate from relocated API/metrics |
| `apps/dashboard/src/api/index.ts` | Default static directory becomes `apps/dashboard/dist` |
| `apps/dashboard/src/api/charts.test.ts` | Spawn moved API entry in integration test |
| `services/crawler/src/loop/cli.ts` | Spawn moved crawler entry; working directory unchanged |
| `services/crawler/src/fetcher/probe.ts` | Resolve moved Python helper from repository root |
| `services/crawler/src/fetcher/transports/transport.ts` | Resolve moved Python helper; import unchanged hardcoded domain set |
| `config/profiles.ts` | Same two-domain transport set moved out of transport module |
| `README.md` | Tree, commands, paths, runtime boundaries and offline validation |
| `apps/dashboard/README.md` | Replace scaffold notes with actual build/run instructions |
| `services/fetcher-impersonate/README.md` | Document existing JSON request/response contract |
| `deploy/exa-crawler.service` | Release directory, entry path and Python executable location |
| `deploy/exa-observatory.service` | Release directory and entry path |
| `deploy/install-observatory.sh` | Updated default initial-install directory |
| `deploy/redeploy.sh` | Offline release preflight, unit backups/path substitution and normal restart |
| `deploy/README.md` | Existing-VM deployment and rollback instructions |
| `docs/DECISIONS.md` | Small layout deviations and unchanged process model |
| `docs/METRICS.md` | Existing metric definitions and timestamp |
| `docs/architecture.md` | Runtime ownership and boundary-check limitations |
| `docs/REORGANIZATION.md` | This audit |
| `fixtures/article.html` | Synthetic extraction fixture |
| `fixtures/feed.xml` | Synthetic discovery fixture |
| `tools/simulator/check-boundaries.mjs` | Dependency-free lexical HTTP/import ownership guard |
| `tools/simulator/architecture.test.ts` | Proves guard rejects misplaced calls/imports and Python DB access |
| `tools/simulator/responses.cjs` | Shared offline fixture response selection |
| `tools/simulator/preload.mjs` | Fixture fetch replacement and real-socket prohibition for crawler smoke |
| `tools/simulator/fake-python.cjs` | Offline one-request subprocess response fixture |
| `tools/simulator/server.mjs` | Optional loopback fixture server |
| `tools/simulator/check-layout.mjs` | Temporary DB backup, old/new query parity and process startup/shutdown smoke |

New import-only library facades: `services/pipeline/src/index.ts`,
`services/pipeline/src/sources/index.ts`, `services/pipeline/src/newness/index.ts`,
`services/pipeline/src/extract/index.ts`.

Parser bodies, worker logic, scheduler logic, SQL schema, Python code, dependency locks,
frontend components/styles, limits and configured domains are unchanged.

## Validation and deployment drift

- 14 tests, root type check, boundary check, dashboard build and lint pass.
  Existing UI lint warnings and the existing large-bundle warning remain.
- Actual crawler and dashboard entries start and stop using a disposable copy of a
  90 MiB production snapshot. Node network is blocked; synthetic responses are substituted.
  Schema, site start times and all existing request rows survive.
- Old/new overview, requests, articles, sources, request detail and all six chart-window
  results match on the same frozen database snapshot.
- Real Python helper passes loopback checks for Chrome/conditional headers, redirects,
  304 responses and oversized bodies. The pipeline facade extracts the saved article fixture.
- Live API code was compared with the Git baseline: formatting and its `version` label
  differed (`0.2.0` live, `1.0.0` already in Git). Redeployment reports Git's existing `1.0.0`.
  No new metric or endpoint logic was introduced to reconcile that metadata drift.
