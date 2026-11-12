import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { MonitorStore } from "../../../../packages/reconciliation/src/store.js";
import { providerConfig } from "../../../../config/monitor.js";
import { sighting } from "../../../../packages/reconciliation/src/identity.js";

for (const endpoint of ["reconciliation", "freshness"])
test(`${endpoint} HTTP endpoint supports all windows, validates filters and never polls providers`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "coverage-api-")),
    db = new DatabaseSync(join(dir, "crawler.sqlite"));
  db.exec(
    "CREATE TABLE articles(canonical_url TEXT,domain TEXT,published TEXT,classification TEXT,payload TEXT,fetched INTEGER,discovered INTEGER)",
  );
  const now = Date.now(),
    url = "https://bbc.com/news/test";
  db.prepare(
    "INSERT INTO articles(canonical_url,domain,published,classification,payload,fetched) VALUES (?,?,?,?,?,?)",
  ).run(
    url,
    "bbc.com",
    new Date(now - 1000).toISOString(),
    "new",
    JSON.stringify({ title: "A sample news story" }),
    now - 500,
  );
  db.close();
  const monitor = new MonitorStore(join(dir, "reconciler.sqlite"));
  monitor.configure(
    providerConfig({}).filter((c) => c.id === "google"),
    now - 1000,
  );
  const job = monitor.claim(now - 1000)!;
  job.site = "bbc.com";
  monitor.success(
    job,
    [sighting("bbc.com", url, "A sample news story", now - 1000, null)!],
    1,
    false,
    null,
    now - 500,
  );
  const port = await new Promise<number>((resolve) => {
    const socket = createServer();
    socket.listen(0, "127.0.0.1", () => {
      const port = (socket.address() as any).port;
      socket.close(() => resolve(port));
    });
  });
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "apps/dashboard/src/api/index.ts"],
    {
      env: {
        ...process.env,
        PORT: String(port),
        CRAWLER_DATA_DIR: dir,
        RECONCILER_DB: join(dir, "reconciler.sqlite"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("API startup timed out")),
        10000,
      );
      child.stdout.once("data", () => {
        clearTimeout(timeout);
        resolve();
      });
      child.once("exit", () => {
        clearTimeout(timeout);
        reject(new Error("API exited"));
      });
    });
    const get = (params: string) =>
      fetch(`http://127.0.0.1:${port}/api/${endpoint}?${params}`);
    for (const window of ["10m", "1h", "24h", "7d"]) {
      const r = await get("window=" + window);
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.window, window);
      if (window === "10m") assert.equal(body.windowEnd - body.windowStart, 600000);
      assert.equal(body.summary.percentage, 100);
      assert.equal(body.cadenceMinutes, 10);
      if (endpoint === "freshness") {
        assert.equal(body.freshness.overall.missingTiming, 1);
        assert.equal(body.freshness.comparison.count, 0);
        assert.deepEqual(body.freshness.comparison.series.map((s: any) => s.id), ["crawler", "google", "exa"]);
        assert.equal(body.freshness.overall.observed.p50, null);
        assert.equal(body.freshness.domains.length, 20);
      }
      assert.equal(body.groups[0].crawler_parsed_at, now - 500);
      assert.equal(body.groups[0].crawler_fetch_finished_at, null);
      assert.equal(body.groups[0].provider_timings[0].published_at, now - 1000);
      assert.equal(body.groups[0].provider_timings[0].observed_at, now - 500);
      assert.equal(body.matrix.length, 20);
      assert.equal(
        body.matrix.find((r: any) => r.site === "sina.com.cn").percentage,
        null,
      );
    }
    for (const params of [
      "window=wrong",
      "site=evil.com",
      "provider=unknown",
      "matches=bad",
      "page=0",
      "page=NaN",
      "page=1.5",
    ])
      assert.equal((await get(params)).status, 400);
    assert.equal(
      (await (await get("provider=exa")).json()).summary.percentage,
      null,
    );
    const matched = await (await get("matches=matched")).json();
    const unmatched = await (await get("matches=unmatched")).json();
    assert.equal(matched.groups.length, 1);
    assert.equal(unmatched.groups.length, 0);
    assert.equal(unmatched.summary.percentage, 100);
    assert.equal((await (await get("page=2")).json()).groups.length, 0);
    assert.equal(
      monitor.db.prepare("SELECT count(*) n FROM provider_runs").get()!.n,
      1,
    );
    assert.equal(
      (
        await fetch(`http://127.0.0.1:${port}/api/${endpoint}`, {
          method: "POST",
        })
      ).status,
      405,
    );
  } finally {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
    monitor.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
