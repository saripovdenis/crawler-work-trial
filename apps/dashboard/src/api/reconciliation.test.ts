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

test("reconciliation HTTP endpoint supports all windows, validates filters and never polls providers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "coverage-api-")),
    db = new DatabaseSync(join(dir, "crawler.sqlite"));
  db.exec(
    "CREATE TABLE articles(canonical_url TEXT,domain TEXT,published TEXT,classification TEXT,payload TEXT,fetched INTEGER)",
  );
  const now = Date.now(),
    url = "https://bbc.com/news/test";
  db.prepare("INSERT INTO articles VALUES (?,?,?,?,?,?)").run(
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
    providerConfig({}).filter((c) => c.id === "gdelt"),
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
      fetch(`http://127.0.0.1:${port}/api/reconciliation?${params}`);
    for (const window of ["1h", "24h", "7d"]) {
      const r = await get("window=" + window);
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.summary.percentage, 100);
      assert.equal(body.matrix.length, 20);
      assert.equal(
        body.matrix.find((r: any) => r.site === "sina.com.cn").percentage,
        null,
      );
    }
    for (const params of ["window=wrong", "site=evil.com", "provider=unknown"])
      assert.equal((await get(params)).status, 400);
    assert.equal(
      (await (await get("provider=exa")).json()).summary.percentage,
      null,
    );
    assert.equal(
      monitor.db.prepare("SELECT count(*) n FROM provider_runs").get()!.n,
      1,
    );
    assert.equal(
      (
        await fetch(`http://127.0.0.1:${port}/api/reconciliation`, {
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
