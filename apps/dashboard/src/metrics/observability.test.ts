import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { Observatory } from "./observability.js";

test("public observability is read-only, bounded, filterable, and inspects saved responses", async () => {
  const dir = mkdtempSync(join(tmpdir(), "observatory-test-"));
  const db = new DatabaseSync(join(dir, "crawler.sqlite"));
  db.exec(`CREATE TABLE meta(key TEXT,value TEXT); CREATE TABLE sites(domain TEXT,started INTEGER,cooldown INTEGER);
    CREATE TABLE sources(domain TEXT,url TEXT,kind TEXT,next_poll INTEGER,polls INTEGER,errors INTEGER,discovered INTEGER,last_error TEXT);
    CREATE TABLE candidates(domain TEXT,state TEXT,priority INTEGER);
    CREATE TABLE requests(id INTEGER PRIMARY KEY,domain TEXT,url TEXT,purpose TEXT,started INTEGER,finished INTEGER,status INTEGER,error TEXT,body_hash TEXT,headers TEXT);
    CREATE TABLE articles(canonical_url TEXT,domain TEXT,discovered INTEGER,fetched INTEGER,published TEXT,classification TEXT,payload TEXT);`);
  const now = Date.now();
  db.prepare("INSERT INTO meta VALUES (?,?)").run(
    "heartbeat",
    new Date(now).toISOString(),
  );
  db.prepare("INSERT INTO meta VALUES (?,?)").run(
    "started",
    new Date(now - 3600_000).toISOString(),
  );
  db.prepare("INSERT INTO sites VALUES (?,?,?)").run(
    "bbc.com",
    now - 3600_000,
    0,
  );
  db.prepare("INSERT INTO sources VALUES (?,?,?,?,?,?,?,?)").run(
    "bbc.com",
    "https://www.bbc.com/",
    "html",
    now,
    3,
    0,
    10,
    null,
  );
  for (let i = 1; i <= 65; i++)
    db.prepare("INSERT INTO requests VALUES (?,?,?,?,?,?,?,?,?,?)").run(
      i,
      "bbc.com",
      "https://www.bbc.com/",
      "discovery",
      now - i * 15000,
      now - i * 15000 + 50,
      i === 65 ? 403 : 200,
      null,
      "a".repeat(64),
      '{"set-cookie":"SECRET"}',
    );
  db.prepare("INSERT INTO articles VALUES (?,?,?,?,?,?,?)").run(
    "https://www.bbc.com/news/articles/123456",
    "bbc.com",
    now - 10_000,
    now,
    new Date(now - 30_000).toISOString(),
    "new",
    JSON.stringify({
      title: "Example title",
      description: "Example description",
      text: "PRIVATE_FULL_ARTICLE",
      dateSource: "jsonld.datePublished",
    }),
  );
  db.close();
  mkdirSync(join(dir, "snapshots"));
  writeFileSync(
    join(dir, "snapshots", "a".repeat(64) + ".gz"),
    gzipSync(
      '<html><body><a href="/news/articles/123456">Example article</a></body></html>',
    ),
  );
  const api = new Observatory(dir);
  try {
    const overview = api.overview() as any;
    assert.equal(overview.totals.fresh, 1);
    assert.equal(overview.totals.p50Delay, 20);
    assert.equal(overview.running, true);
    assert.throws(() => api.db.exec("DELETE FROM requests"), /readonly/);
    const first = api.requests(new URLSearchParams());
    assert.equal(first.items.length, 60);
    assert.equal(first.nextCursor, 6);
    const next = api.requests(new URLSearchParams("before=6"));
    assert.equal(next.items.length, 5);
    assert.equal(
      api.requests(new URLSearchParams("errors=true")).items.length,
      1,
    );
    assert.equal(
      api.requests(new URLSearchParams("domain=sina.com.cn")).items.length,
      0,
    );
    assert.throws(
      () => api.requests(new URLSearchParams("domain=evil.example")),
      /Invalid/,
    );
    assert.throws(
      () => api.requests(new URLSearchParams("before=NaN")),
      /Invalid/,
    );
    assert.ok(!JSON.stringify(first).includes("SECRET"));
    assert.ok(
      !JSON.stringify(api.articles(new URLSearchParams())).includes(
        "PRIVATE_FULL_ARTICLE",
      ),
    );
    assert.equal(
      api.articles(new URLSearchParams("q=Example")).items.length,
      1,
    );
    const detail = await api.requestDetail(1);
    assert.equal(detail?.linkCount, 1);
    assert.ok(!JSON.stringify(detail).includes("SECRET"));
    assert.equal(await api.requestDetail(999), null);
  } finally {
    api.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
