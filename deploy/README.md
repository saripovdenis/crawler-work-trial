# Current deployment

Use [the durable scheduler deployment](../docs/SCHEDULER.md#deployment-and-rollback).
`redeploy.sh` delegates to `deploy-durable.sh`; use a `/opt/exa-crawler/durable-COMMIT` release.
The dashboard remains on its current release.

## Historical layout-only deployment

# Existing VM deployment

Two Node services, unchanged users, environment names, limits, ports and public URL.
No Docker/compose exists. Caddy stays untouched. The database stays at
`/var/lib/exa-crawler/data/crawler.sqlite`.

1. Run type checks, boundary check and dashboard build locally. Inspect the UI manually.
2. Archive the committed release into `/opt/exa-crawler/layout-COMMIT` on the VM.
   Include locally built `apps/dashboard/dist`; do not include local dependencies or data.
3. Run `sudo bash deploy/redeploy.sh /opt/exa-crawler/layout-COMMIT` from that release.
   It installs existing pinned dependencies, runs static checks, updates only
   service code paths and performs one normal restart of each existing Node service.
4. Check `/api/health`, `/api/overview`, `/charts`, service logs and preserved startup/budget history.

Templates default to `/opt/exa-crawler/layout-v1`; the script substitutes the release path.
The Python executable remains release-local. WorkingDirectory remains the release root.
`install-observatory.sh` is the original initial-provisioning helper; redeploy uses the script above.

Rollback: restore both units from `RELEASE/deploy/previous-units`, daemon-reload and restart
the same services. Old code releases remain on disk. No database rollback or migration is needed.

## External reconciliation

See [reconciler deployment and quotas](../docs/RECONCILIATION.md).
`deploy-reconciler.sh` updates the scheduler/API release and installs the separate
`exa-reconciler` service. It preserves the running fetch worker and existing data.
