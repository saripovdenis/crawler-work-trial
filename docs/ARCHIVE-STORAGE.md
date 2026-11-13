# Response storage rollout

## Current stage: local reads, asynchronous Garage mirror

Rows and the request ledger remain in PostgreSQL. Every response keeps its
`snapshots/<sha256>.gz` key. The hash covers the decompressed body. Local archive
writes remain durable before the existing completion callback. No publisher
request is retried because an upload failed.

`fetch_finished_at` records the end of the body read, before decoding, hashing,
compression and storage. `finished_at` remains the completed worker receipt.
The scheduler validates their order and uses the fetch timestamp for
`requests.finished`, spacing and discovery time. Coverage/Freshness prefer the
new timestamp, falling back to the original receipt time for old records.
Existing timestamps are not rewritten. The single site slot still releases at
the completion callback; only the spacing anchor changes in this stage.

All five body readers use `BodyStore`: extraction cache, scheduler, its reuse
check, dashboard request details, and publication repair. The initial adapter
is local. Its synchronous `valid()` probe is local-only and must never perform
network I/O inside a claim transaction. Switching other reads to an asynchronous
S3 adapter is a later rollout step, not enabled by this release.

With `ARCHIVE_MIRROR=1`, the fetch worker durably queues a body hash under
`receipts/archive-mirror/pending/` before acknowledging completion. A separate
worker thread uploads existing compressed bytes. Successful upload markers go
to `uploaded/`; pending markers survive restarts. Replayed queue entries use
the same content key. Backoff is capped at 60 seconds; individual uploads time
out after five seconds. Uploads never delay the callback or use publisher budget.
Enqueue filesystem failures are logged and do not fail a successful fetch;
the mirror is optional during this stage. Only bodies observed after enabling
the mirror are queued; historical backfill is not automatic.

## Garage

`deploy/install-archive.sh` installs Garage **2.5.0** from its official release
with a pinned SHA-256, then enables `exa-archive.service`. The canonical master
deployment invokes it before stopping any crawler process.

- Single node, replication factor 1: this is a trial, not redundant storage.
- Data and metadata live under `/var/lib/exa-crawler/garage` on the data disk.
- Both `data_fsync` and `metadata_fsync` are explicitly enabled; metadata
  snapshots run every six hours. These settings reduce crash loss; they do not
  replace retaining local originals or independent backups.
- S3 binds to `127.0.0.1:3900`, RPC to `127.0.0.1:3901`. No web/admin port.
- A separate OS user and a 512 MiB memory cap isolate the archive process.
- Root-only `/etc/exa-archive-writer.env` gives the fetch worker write access.
  `/etc/exa-archive-reader.env` gives verification and future readers read access.
  Neither key owns the bucket. Garage's write permission also allows deletion;
  our adapter only exposes PUT and GET, with no delete operation.
- The only allowed S3 SDK module is `packages/protocol/src/storage-client.ts`.
  It rejects non-loopback endpoints, URL credentials and paths. No arbitrary
  request URLs, redirects or publisher hosts are accepted.

The adapter uses the S3 protocol, but moving to GCS also requires endpoint,
authentication and compatibility validation; it is not promised as a config-only
switch. Conditional writes and object versions are not required by this stage.

## Verification and the one-day gate

`/api/cache` includes mirror counts, pending/oldest work, errors and upload
latency. It also includes the most recent hash-verification summary.
`exa-archive-verify.timer` checks up to 1,000 previously unverified objects every
five minutes with the read-only key. It reads the current deployed release from
the root-owned release manifest and remains separate from the fetch worker.
Run verification with the read-only key from the currently deployed directory:

```sh
sudo env CRAWLER_DATA_DIR=/var/lib/exa-crawler/data ARCHIVE_VERIFY_LIMIT=100000 ARCHIVE_VERIFY_ALL=1 \
  /usr/local/bin/node --env-file=/etc/exa-archive-reader.env --import tsx \
  tools/storage/verify-mirror.ts
```

It compares decompressed SHA-256 and bytes with local originals, recording
verified hashes locally so a later incremental run checks newly uploaded bodies.
`ARCHIVE_VERIFY_ALL=1` rechecks every object for the one-day comparison. It has
no publisher access. `remaining` and `errors` must be zero for full comparison.
Upload markers are evidence of successful PUTs; hash verification is separate.

After at least one day, inspect upload latency, queue age, errors, count and
hash agreement, and normal crawler throughput. Only then switch readers to
Garage with local fallback and run a bounded historical backfill. Keep the
claim-time probe local or use persisted availability metadata prepared outside
the transaction. The final migration to a private worker spool and separate
`fetched`/`stored` callbacks needs a distinct durable storage state and retry
horizon; the current 60-second fetch lease must not be reused for upload retries.

Rollback: set `ARCHIVE_MIRROR=0` in the writer environment file and use the normal
master deployment. Local reads/archives need no conversion. Pending mirror work
remains available for resuming. Do not delete the request ledger, receipts or
local bodies during this trial.

References: [Garage configuration](https://garagehq.deuxfleurs.fr/documentation/reference-manual/configuration/),
[single-node setup](https://garagehq.deuxfleurs.fr/documentation/quick-start/),
[official releases](https://garagehq.deuxfleurs.fr/_releases.html).
