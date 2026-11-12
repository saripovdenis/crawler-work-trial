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
boundary check, frontend build, and a Python transport import. It does not run
automated tests or send validation requests to publishers. Both SQLite databases
are backed up in the release directory. Existing service users, settings, ports,
secrets, disk paths and public URLs are preserved.

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
frontend assets come from that same master commit. Old releases remain available
for diagnosis and emergency rollback.

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
