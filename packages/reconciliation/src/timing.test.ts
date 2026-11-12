import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { matchSightings } from "./view.js";
import { attachFetchTiming } from "./timing.js";
import { sighting } from "./identity.js";
const now = Date.parse("2026-11-12T12:00:00Z");
const url = "https://bbc.com/news/test";
function groups() {
  return matchSightings(
    [
      {
        ...sighting("bbc.com", url, "A sample headline", now - 600000)!,
        id: 1,
        run_id: 1,
        provider: "exa",
        site: "bbc.com",
        observed_at: now,
      },
    ],
    [
      {
        canonical_url: url,
        source_url: url,
        domain: "bbc.com",
        published: new Date(now - 600000).toISOString(),
        title: "A sample headline",
        classification: "new",
        fetched: now + 10000,
        discovered: now - 20000,
      },
    ],
  );
}
function database(durable: boolean) {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE requests(id INTEGER PRIMARY KEY,url TEXT,domain TEXT,purpose TEXT,status INTEGER,error TEXT,finished INTEGER)",
  );
  if (durable)
    db.exec(
      "CREATE TABLE attempt_assignments(request_id INTEGER,attempt_id TEXT,completion TEXT,processing TEXT,task_id INTEGER);CREATE TABLE crawl_tasks(id INTEGER,url TEXT)",
    );
  return db;
}
test("timing uses network finish from receipt, not receipt arrival or parse completion; deltas remain signed", () => {
  const db = database(true);
  try {
    db.prepare("INSERT INTO requests VALUES (1,?,?,?,200,NULL,?)").run(
      url,
      "bbc.com",
      "article",
      now + 5000,
    );
    db.prepare("INSERT INTO crawl_tasks VALUES (1,?)").run(url);
    db.prepare(
      "INSERT INTO attempt_assignments VALUES (1,'attempt',?,'done',1)",
    ).run(JSON.stringify({ finished_at: new Date(now - 1000).toISOString() }));
    const rows = groups();
    attachFetchTiming(db, rows);
    assert.equal(rows[0].crawler_fetch_finished_at, now - 1000);
    assert.equal(rows[0].crawler_parsed_at, now + 10000);
    assert.equal(rows[0].crawler_fetch_time_source, "worker_receipt");
    assert.equal(rows[0].crawler_request_id, 1);
    assert.equal(rows[0].provider_timings[0].fetch_minus_observed_ms, -1000);
    assert.equal(rows[0].provider_timings[0].fetch_minus_published_ms, 599000);
    assert.equal(rows[0].provider_timings[0].provider_first_seen_at, null);
  } finally {
    db.close();
  }
});
test("legacy records use recorded finish; failed, audit, pending and later fetches cannot supply article timing", () => {
  const db = database(false);
  try {
    const put = db.prepare("INSERT INTO requests VALUES (?,?,?,?,?,?,?)");
    put.run(1, url, "bbc.com", "article", 500, null, now - 3000);
    put.run(2, url, "bbc.com", "audit", 200, null, now - 2000);
    put.run(3, url, "bbc.com", "article", 200, null, now + 20000);
    put.run(4, url, "bbc.com", "article", 200, "timeout", now - 1000);
    const rows = groups();
    attachFetchTiming(db, rows);
    assert.equal(rows[0].crawler_fetch_finished_at, null);
    put.run(5, url, "bbc.com", "article", 200, null, now + 1000);
    attachFetchTiming(db, rows);
    assert.equal(rows[0].crawler_fetch_finished_at, now + 1000);
    assert.equal(rows[0].crawler_fetch_time_source, "legacy_request_finished");
  } finally {
    db.close();
  }
});
test("redirected durable fetch links through original task; pending parse and invalid receipt remain unknown", () => {
  const db = database(true);
  try {
    db.prepare("INSERT INTO requests VALUES (1,?,?,?,200,NULL,?)").run(
      url + "/redirect",
      "bbc.com",
      "article",
      now + 5000,
    );
    db.prepare("INSERT INTO crawl_tasks VALUES (1,?)").run(url);
    db.prepare(
      "INSERT INTO attempt_assignments VALUES (1,'attempt',?,'pending',1)",
    ).run(JSON.stringify({ finished_at: new Date(now).toISOString() }));
    let rows = groups();
    attachFetchTiming(db, rows);
    assert.equal(rows[0].crawler_fetch_finished_at, null);
    db.exec("UPDATE attempt_assignments SET processing='done'");
    attachFetchTiming(db, rows);
    assert.equal(rows[0].crawler_fetch_finished_at, now);
    db.exec("UPDATE attempt_assignments SET completion='{}'");
    rows = groups();
    attachFetchTiming(db, rows);
    assert.equal(rows[0].crawler_fetch_finished_at, null);
  } finally {
    db.close();
  }
});
