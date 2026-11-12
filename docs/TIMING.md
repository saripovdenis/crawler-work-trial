# Request timing diagnostics

Set `CRAWLER_TIMING_LOGS=1` on **both** the scheduler and fetch worker at process
startup. Disabled by default. Enable through the normal coordinated master
release; do not replace or restart individual production services for this.
No extra service, database migration, publisher request or tracing dependency.

Each JSON line has `event: "crawler_timing"`, a UTC `at`, and a `stage`.
Join fetch and processing lines by `attempt_id`; processing/persist lines also
carry the dashboard's numeric `request_id`. `claim_id` joins the claim handshake.
No response content, request headers, lease tokens or URL query strings are logged.

| Stage | What its times mean |
| --- | --- |
| `claim_client` | Worker-to-scheduler round trip; excludes subsequent receipt writes. Fast empty claims are omitted. |
| `scheduler` | HTTP handler total plus synchronous claim/complete handler time on success. |
| `receipt_write` | JSON serialization and the existing atomic file write, rename, file/directory fsync. No additional write is performed. |
| `fetch` | Dispatch wait; response wait; body read; decode/hash; archive verification/compression/write; total execute time. |
| `complete_client` | Completion acknowledgement round trip, including failed attempts. |
| `parse_selection` | Pending-work selection when it takes at least 100 ms. |
| `processing` | Queue wait since the original fetch finished, worker round trip, discovery mapping, persistence, total processing time and extraction cache hit. |
| `persist` | SQLite transaction (including lock wait/commit) and JSONL export separately. |
| `slow_sql` | Scheduler query templates taking at least 100 ms; bound values are omitted. |

`processing.worker_ms` measures work inside the parser worker.
`extraction_ms` isolates the existing `discover`/`parseArticle` call;
`cache_archive_ms` is the remainder (cache lookup, archive read/verification,
decode, serialization, cache compression/writes/pruning). `parse_roundtrip_ms`
also includes worker startup, message transfer and time waiting to resume the
scheduler. Nested times overlap: do not add them all together.

For Node transport, `response_wait_ms` combines connection setup and waiting for
response headers. DNS/TCP/TLS are **not** individually measured. For `chrome136`,
the Python helper returns a buffered response: that field includes Python startup,
the full HTTP request/body and IPC. `body_read_ms` then drains the already-buffered
body. Check `response_wait_scope` before comparing transports.

All durations use a monotonic clock except `queue_wait_ms` and
`dispatch_wait_ms`, which compare persisted UTC timestamps on the same VM.
They are wall time, not CPU time: preemption and I/O waits are included.
Queue wait for an archived reparse is measured from its original fetch, not from
the repair request. `dispatch_wait_ms` starts at reservation, inferred from the
existing dispatch deadline; it is not the candidate's discovery-to-fetch delay.
No discovery/fetch/publication timestamps or budget rules are changed.

On the VM after enabling:

```sh
sudo journalctl -u exa-crawler -u exa-fetch-worker -o cat --since '5 min ago' |
  rg '"event":"crawler_timing"'
```

Enable temporarily: per-request diagnostics add log volume. Logs go to the
existing stdout/journal sink; they do not create another durable telemetry file.
Some discovery-mapping cache entries will be rebuilt after deployment because
the existing mapping version includes the scheduler source file.
