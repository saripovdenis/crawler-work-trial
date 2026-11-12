import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { providerConfig } from "../../../config/monitor.js";
import { MonitorStore } from "../../../packages/reconciliation/src/store.js";
import { acquireLock } from "../../../packages/protocol/src/files.js";
import { collect } from "./providers.js";
import { ProviderError } from "./client.js";
const path = resolve(process.env.RECONCILER_DB || "data/reconciler.sqlite");
const store = new MonitorStore(path);
const release = acquireLock(path + ".pid");
const configs = providerConfig();
store.configure(configs);
let stopped = false;
for (const event of ["SIGINT", "SIGTERM"])
  process.on(event, () => (stopped = true));
console.log("Reconciler started; provider cadence 30 minutes");
async function worker() {
  try {
    while (!stopped) {
      store.db
        .prepare("INSERT OR REPLACE INTO monitor_meta VALUES ('heartbeat',?)")
        .run(String(Date.now()));
      const job = store.claim();
      if (!job) {
        await sleep(1000);
        continue;
      }
      try {
        const batch = await collect(
          job.provider,
          job.site,
          configs.find((c) => c.id === job.provider)?.key,
          job.from,
          job.to,
        );
        store.success(
          job,
          batch.items,
          batch.rawCount,
          batch.truncated,
          batch.providerCost,
        );
        console.log(
          JSON.stringify({
            provider: job.provider,
            site: job.site,
            count: batch.items.length,
            truncated: batch.truncated,
          }),
        );
      } catch (e) {
        const retry =
          e instanceof ProviderError && [429, 503].includes(e.status)
            ? Math.max(Date.now() + 60000, e.retryAfter || 0)
            : null;
        const error =
          e instanceof ProviderError
            ? e.message
            : e instanceof SyntaxError
              ? "Invalid provider JSON"
              : e instanceof Error
                ? e.name + ": " + e.message
                : "Provider request failed";
        store.failure(job, error, retry);
        console.error(
          JSON.stringify({ provider: job.provider, site: job.site, error }),
        );
        if (
          e instanceof ProviderError &&
          [401, 402, 403].includes(e.status) &&
          job.provider === "exa"
        )
          store.db
            .prepare(
              "UPDATE provider_state SET enabled=0,note=? WHERE provider=?",
            )
            .run(error, job.provider);
      }
    }
  } catch (error) {
    stopped = true;
    throw error;
  }
}
// Bound memory and avoid a slow provider blocking the other providers. Each
// claim still applies the same persisted per-provider spacing and quota cap.
try {
  const results = await Promise.allSettled(
    Array.from({ length: 2 }, () => worker()),
  );
  const failure = results.find((r) => r.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
} finally {
  store.db.close();
  release();
}
