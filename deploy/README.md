# Production releases: master only

`master` is the sole deployable branch. Feature branches, including
`codex/observability`, must be merged into it first. All four existing services
run one release: scheduler/pipeline, fetch worker, dashboard/API and reconciler.

## Deploy

On the existing VM:

```sh
sudo /usr/local/sbin/deploy-exa-master
# Or require an exact current master commit (40 hexadecimal characters):
sudo /usr/local/sbin/deploy-exa-master FULL_MASTER_SHA
```

The root-owned entrypoint is an installed copy of `deploy/deploy-master.sh`.
It resolves `refs/heads/master` directly from GitHub, downloads that immutable
commit, verifies its own script matches that commit, and builds the frontend
from the same source. It never accepts local source archives or a branch name.
An explicit SHA must equal current master, which is checked again before cutover.

The command holds `/run/lock/exa-crawler-deploy.lock` throughout preparation and
cutover. A second release fails rather than racing. Legacy deployments already
running also prevent a cutover. Do not bypass these guards.

Preparation runs dependency installation, type checks, the static outbound/import
boundary check, frontend build, and the Python worker import check. It does not run
automated tests or send validation requests to publishers. The PostgreSQL
`crawl_budget` schema is dumped into the release directory. Existing service users, settings, ports,
secrets, disk paths and public URLs are preserved.

The renderer sets `exa-fetch-worker` to the release virtualenv Python and
`services/fetcher-impersonate/worker.py`. Because the canonical deploy script changed,
its root-owned installed copy must first be updated from the merged master version;
its existing self-comparison guard enforces this.

The worker stops first; then the other three services stop. Their units switch
together. Scheduler/API/reconciler start, then the worker starts after scheduler
health passes. Durable charges and receipts are retained. Health checks cover
scheduler, API, `/api/freshness`, the Freshness page, and consistent service paths.
Failed cutovers restore the previous units; databases and budget history are never
rolled back automatically.

Successful release identity is stored in:

```text
/var/lib/exa-crawler/deployments/current.json
```

Release directories are named `/opt/exa-crawler/master-SHA-UTC`. Source and
frontend assets come from that same master commit. After a successful
cutover only that release and the one it replaced are kept; every other
directory under `/opt/exa-crawler`, with its database backups, is removed.

## Install or update the entrypoint

From a clean checkout of current master, copy `deploy/deploy-master.sh` to the VM
and install it as root-owned `/usr/local/sbin/deploy-exa-master`, mode `0755`.
The command refuses to deploy if this installed script differs from current master;
update it when deployment logic changes. `deploy/redeploy.sh` delegates to it.
The former durable/reconciler/install scripts intentionally fail with directions
to the canonical command.

These are operational safeguards, not an access-control boundary against a root
administrator. Do not run historical archive scripts or edit live unit paths by
hand. Any future CI must call this same command and deploy only `master`.

## PostgreSQL

All rows live in PostgreSQL: database `crawler`, schema `crawl_budget`, owned by
the `exa-crawler` role, reached over the local socket with peer authentication.
The scheduler, dashboard and reconciler get `PGHOST` and `PGDATABASE` from their
units. Archives, receipts and status files stay under `/var/lib/exa-crawler`.

The deploy command installs PostgreSQL if it is missing and creates the role and
database. On the first PostgreSQL release it stops all four services, copies both
SQLite files read-only into `/var/lib/exa-crawler/sqlite-archive/<UTC>/`, loads
PostgreSQL from that copy with `deploy/migrate-sqlite-to-postgres.py`, and records
`/var/lib/exa-crawler/deployments/postgres-cutover.json` once health checks pass.
The original SQLite files are left in place and are never written again. If that
first cutover fails, the previous units are restored and the partial schema is
dropped, so SQLite remains the live store.

Returning to a SQLite release after a successful cutover loses every row written
since: the SQLite files are frozen at the cutover.
