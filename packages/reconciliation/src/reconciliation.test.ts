import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MonitorStore } from "./store.js";
import { providerConfig, pollInterval } from "../../../config/monitor.js";
import { sighting, titleKey, urlKey } from "./identity.js";
import { matchSightings, CoverageReader } from "./view.js";
const now = Date.parse("2026-11-12T12:00:00Z");
const url = "https://www.bbc.com/news/a";
const item = sighting(
  "bbc.com",
  url,
  "A sufficiently descriptive title",
  now - 3600000,
  null,
)!;
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "reconcile-"));
  const path = join(dir, "monitor.sqlite");
  return {
    dir,
    path,
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}
test("quota reservation survives restart, failed/uncertain calls stay charged, rolling and lifetime caps hold", () => {
  const f = fixture();
  let store = new MonitorStore(f.path);
  const config = providerConfig({
    EXA_API_KEY: "test",
    MONITOR_EXA_DAILY_LIMIT: "1",
    MONITOR_EXA_TOTAL_LIMIT: "2",
  }).filter((c) => c.id === "exa");
  try {
    store.configure(config, now);
    const first = store.claim(now)!;
    assert.equal(first.provider, "exa");
    assert.equal(store.claim(now + 100000), null);
    store.db.close();
    store = new MonitorStore(f.path);
    store.configure(config, now + 200000);
    assert.equal(
      store.db.prepare("SELECT status FROM provider_runs").get()!.status,
      "interrupted",
    );
    assert.equal(store.claim(now + 200000), null);
    const second = store.claim(now + 86400001)!;
    assert.ok(second);
    store.failure(second, "timeout", now + 86400100, now + 86400002);
    assert.equal(store.claim(now + 2 * 86400000 + 1000), null);
    assert.equal(
      store.db.prepare("SELECT sum(quota_used) n FROM provider_runs").get()!.n,
      2,
    );
  } finally {
    store.db.close();
    f.close();
  }
});
test("upsert preserves first observation, overlap catches outages, provider cooldown persists", () => {
  const f = fixture(),
    s = new MonitorStore(f.path);
  try {
    s.configure(
      providerConfig({}).filter((c) => c.id === "google"),
      now,
    );
    const first = s.claim(now)!;
    s.success(first, [item], 1, false, null, now + 1);
    s.db
      .prepare("UPDATE provider_schedule SET next_poll=? WHERE site=?")
      .run(now + 1800000, first.site);
    s.db
      .prepare("UPDATE provider_schedule SET next_poll=? WHERE site<>?")
      .run(now + 9e8, first.site);
    const again = s.claim(now + 1800000)!;
    assert.equal(again.from, now - 3600000);
    s.success(again, [item], 1, false, null, now + 1800001);
    assert.equal(
      s.db.prepare("SELECT observed_at FROM external_sightings").get()!
        .observed_at,
      now + 1,
    );
    assert.equal(
      s.db.prepare("SELECT count(*) n FROM external_sightings").get()!.n,
      1,
    );
    const third = s.claim(now + 3600000)!;
    s.failure(third, "HTTP 429", now + 9e8);
    assert.equal(s.claim(now + 7200000), null);
  } finally {
    s.db.close();
    f.close();
  }
});
test("matching uses normalized URLs, unique title/time fallback, dedupes providers, rejects ambiguous titles", () => {
  const row = { ...item, provider: "exa", site: "bbc.com", observed_at: now };
  const article = {
    canonical_url: url,
    source_url: url,
    domain: "bbc.com",
    title: item.title,
    published: new Date(now - 3600000).toISOString(),
    classification: "incomplete",
  };
  const google = {
    ...row,
    provider: "google",
    url_raw: "https://news.google.com/rss/articles/123",
    url_key: null,
  };
  const groups = matchSightings([row, google], [article]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].providers.length, 2);
  assert.equal(groups[0].match, "url");
  assert.equal(groups[0].incomplete, true);
  assert.equal(matchSightings([google], [article])[0].match, "title");
  assert.equal(
    matchSightings(
      [google],
      [article, { ...article, canonical_url: url + "2" }],
    )[0].match,
    null,
  );
  assert.equal(
    matchSightings([{ ...google, provider_published_at: null }], [article])[0]
      .match,
    null,
  );
  assert.equal(
    matchSightings([{ ...google, site: "sina.com.cn" }], [article])[0].match,
    null,
  );
  assert.equal(matchSightings([row, google], []).length, 1);
  assert.equal(urlKey("http://bbc.com/news/a/?utm_source=x"), urlKey(url));
  assert.equal(titleKey("Ａ  Title!"), titleKey("a title"));
});
test("coverage agrees with SQL, handles all filters, excludes pending/failures, never writes crawler DB", () => {
  const f = fixture(),
    s = new MonitorStore(f.path),
    crawlerPath = join(f.dir, "crawler.sqlite"),
    db = new DatabaseSync(crawlerPath);
  try {
    db.exec(
      "CREATE TABLE articles(canonical_url TEXT,domain TEXT,published TEXT,classification TEXT,payload TEXT,discovered INTEGER,fetched INTEGER);CREATE TABLE candidates(url TEXT,state TEXT)",
    );
    db.prepare(
      "INSERT INTO articles(canonical_url,domain,published,classification,payload) VALUES (?,?,?,?,?)",
    ).run(
      url,
      "bbc.com",
      new Date(now - 3600000).toISOString(),
      "new",
      JSON.stringify({ title: item.title, sourceUrl: url }),
    );
    db.prepare("INSERT INTO candidates VALUES (?,?)").run(
      url + "missing",
      "pending",
    );
    s.configure(
      providerConfig({}).filter((c) => c.id === "google"),
      now - 3600000,
    );
    const job = s.claim(now - 3600000)!;
    job.site = "bbc.com";
    s.success(
      job,
      [
        item,
        sighting(
          "bbc.com",
          url + "missing",
          "Unmatched pending story",
          now - 3600000,
          null,
        )!,
      ],
      2,
      false,
      null,
      now - 3600000 + 1,
    );
    const reader = new CoverageReader(f.path, crawlerPath);
    const before = db.prepare("SELECT * FROM articles").all();
    for (const window of ["1h", "24h", "7d"]) {
      const view = reader.get(new URLSearchParams({ window }), now);
      assert.equal(view.summary?.total, 2);
      assert.equal(view.summary?.matched, 1);
      assert.equal(view.summary?.percentage, 50);
      assert.equal(view.summary?.unmatched, 1);
      assert.equal(
        view.matrix.find((r) => r.site === "sina.com.cn")!.percentage,
        null,
      );
      assert.equal(
        view.summary?.total,
        s.db
          .prepare(
            "SELECT count(*) n FROM external_sightings WHERE observed_at>=? AND observed_at<?",
          )
          .get(now - 3600000, now)!.n,
      );
    }
    const params = new URLSearchParams();
    assert.strictEqual(reader.get(params, now), reader.get(params, now + 1000));
    assert.equal(
      reader.get(new URLSearchParams("site=sina.com.cn"), now).summary?.total,
      0,
    );
    assert.equal(
      reader.get(new URLSearchParams("provider=exa"), now).summary?.percentage,
      null,
    );
    for (const filter of ["window=bad", "site=evil.com", "provider=bad"])
      assert.throws(
        () => reader.get(new URLSearchParams(filter), now),
        /Invalid/,
      );
    assert.deepEqual(db.prepare("SELECT * FROM articles").all(), before);
  } finally {
    db.close();
    s.db.close();
    f.close();
  }
});

test("audit import waits for grace, skips known articles/candidates, persists cursor and never alters discoveries", async () => {
  const { importAudits } = await import("./audits.js");
  const f = fixture(),
    store = new MonitorStore(f.path),
    db = new DatabaseSync(join(f.dir, "crawler.sqlite"));
  try {
    db.exec(
      "CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE articles(canonical_url TEXT,payload TEXT);CREATE TABLE candidates(url TEXT);CREATE TABLE crawl_tasks(domain TEXT,url TEXT,purpose TEXT,priority INTEGER,next_crawl_at INTEGER,current_url TEXT,UNIQUE(url,purpose))",
    );
    db.prepare("INSERT INTO articles VALUES (?,?)").run(
      url,
      JSON.stringify({ sourceUrl: url }),
    );
    db.prepare("INSERT INTO candidates VALUES (?)").run(url + "pending");
    for (const suffix of ["", "pending", "missing", "fresh"]) {
      const raw = url + suffix;
      store.db
        .prepare(
          "INSERT INTO audit_candidates(url_key,url,domain,created_at) VALUES (?,?,?,?)",
        )
        .run(
          urlKey(raw)!,
          raw,
          "bbc.com",
          suffix === "fresh" ? now : now - 3600000,
        );
    }
    assert.equal(importAudits(db, f.path, now), 1);
    assert.equal(importAudits(db, f.path, now), 0);
    assert.equal(db.prepare("SELECT count(*) n FROM articles").get()!.n, 1);
    assert.equal(importAudits(db, f.path, now + 1800000), 1);
    assert.equal(db.prepare("SELECT count(*) n FROM crawl_tasks").get()!.n, 2);
  } finally {
    db.close();
    store.db.close();
    f.close();
  }
});

test("only Google and Exa are configured; retired provider history cannot restart polling", () => {
  const configs = providerConfig({
    EXA_API_KEY: "test",
    NEWSAPI_AI_KEY: "ignored",
    SERPER_API_KEY: "ignored",
  });
  assert.deepEqual(
    configs.map((c) => c.id),
    ["google", "exa"],
  );
  const f = fixture(),
    store = new MonitorStore(f.path);
  try {
    store.db.exec(
      "INSERT INTO provider_state VALUES ('gdelt',1,1000,0,0,NULL);INSERT INTO provider_schedule VALUES ('gdelt','bbc.com',0,NULL);INSERT INTO provider_runs(provider,site,started_at,status) VALUES ('gdelt','bbc.com',0,'ok')",
    );
    store.configure(configs, now);
    assert.equal(
      store.db
        .prepare("SELECT enabled FROM provider_state WHERE provider='gdelt'")
        .get()!.enabled,
      0,
    );
    assert.notEqual(store.claim(now)?.provider, "gdelt");
    assert.equal(
      store.db
        .prepare("SELECT count(*) n FROM provider_runs WHERE provider='gdelt'")
        .get()!.n,
      1,
    );
  } finally {
    store.db.close();
    f.close();
  }
});

test("ten-minute cadence advances old schedules without resetting quota or cooldown", () => {
  const f = fixture(),
    store = new MonitorStore(f.path);
  const config = providerConfig({}).filter((c) => c.id === "google");
  try {
    assert.equal(pollInterval, 600000);
    assert.equal(config[0].daily, 3000);
    assert.equal(
      providerConfig({ EXA_API_KEY: "test" }).find((c) => c.id === "exa")!
        .lifetime,
      1000,
    );
    store.configure(config, now);
    const job = store.claim(now)!;
    store.success(job, [], 0, false, null, now + 1000);
    store.db
      .prepare("UPDATE provider_schedule SET next_poll=? WHERE site=?")
      .run(now + 1800000, job.site);
    store.db
      .prepare("UPDATE provider_schedule SET next_poll=? WHERE site<>?")
      .run(now + 86400000, job.site);
    store.db.prepare("UPDATE provider_state SET next_call=?").run(now + 700000);
    store.configure(config, now + 100000);
    assert.equal(
      store.db
        .prepare("SELECT next_poll FROM provider_schedule WHERE site=?")
        .get(job.site)!.next_poll,
      now + 600000,
    );
    assert.equal(store.claim(now + 600000), null);
    assert.ok(store.claim(now + 700000));
    assert.equal(
      store.db.prepare("SELECT sum(quota_used) n FROM provider_runs").get()!.n,
      2,
    );
  } finally {
    store.db.close();
    f.close();
  }
});

test("provider observations preserve each first timestamp and publication across repeated polls", () => {
  const f = fixture(),
    store = new MonitorStore(f.path);
  try {
    store.configure(providerConfig({ EXA_API_KEY: "test" }), now);
    const job = store.claim(now)!;
    store.success(job, [item], 1, false, null, now + 1000);
    store.success(
      { ...job, id: job.id + 100 },
      [{ ...item, provider_published_at: now + 100000 }],
      1,
      false,
      null,
      now + 600000,
    );
    const row = store.db.prepare("SELECT * FROM external_sightings").get()!;
    assert.equal(row.provider_published_at, item.provider_published_at);
    assert.equal(row.observed_at, now + 1000);
    assert.equal(row.last_observed_at, now + 600000);
    assert.equal(row.run_id, job.id);
    const other = {
      ...row,
      id: 2,
      provider: "exa",
      observed_at: now + 2000,
      provider_published_at: now - 3000000,
    };
    const groups = matchSightings([{ ...row, provider: "google" }, other], []);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].provider_timings.length, 2);
    assert.deepEqual(
      groups[0].provider_timings.map((t) => t.published_at),
      [item.provider_published_at, now - 3000000],
    );
  } finally {
    store.db.close();
    f.close();
  }
});
