import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MonitorStore } from "./store.js";
import { CoverageReader, matchSightings } from "./view.js";
import { sighting } from "./identity.js";
import { freshnessSummary, percentiles } from "./freshness.js";
import { providerConfig } from "../../../config/monitor.js";

test("nearest-rank percentiles retain negative values, empty and small samples", () => {
  assert.deepEqual(percentiles([]), { count: 0, p50: null, p75: null, p90: null });
  assert.deepEqual(percentiles([42]), { count: 1, p50: 42, p75: 42, p90: 42 });
  assert.deepEqual(percentiles([20, -40, 10, -10, NaN]), { count: 4, p50: -10, p75: 10, p90: 20 });
});

test("union counts a matched article once, provider timestamps stay separate, missing is not zero", () => {
  const raw = sighting("bbc.com", "https://bbc.com/news/a", "A sufficiently detailed headline", 1000)!;
  const groups = matchSightings([
    { ...raw, provider: "google", site: "bbc.com", observed_at: 5000, id: 1 },
    { ...raw, provider: "exa", site: "bbc.com", observed_at: 7000, provider_published_at: 2000, id: 2 },
  ], [{ canonical_url: raw.url_raw, domain: "bbc.com", classification: "incomplete" }]);
  groups[0].crawler_fetch_finished_at = 6000;
  assert.equal(freshnessSummary(groups).timed, 1);
  assert.equal(freshnessSummary(groups).incomplete, 1);
  assert.equal(freshnessSummary(groups).observed.p50, 1000);
  assert.equal(freshnessSummary(groups, "exa").observed.p50, -1000);
  assert.equal(freshnessSummary(groups).published.p50, 5000);
  assert.equal(freshnessSummary(groups, "exa").published.p50, 4000);
  groups[0].crawler_fetch_finished_at = null;
  assert.equal(freshnessSummary(groups).missingTiming, 1);
  assert.equal(freshnessSummary(groups).observed.p50, null);
  groups[0].match = null;
  assert.equal(freshnessSummary(groups).unmatched, 1);
});

test("freshness uses the full sample before pagination, matches direct SQL and preserves coverage", () => {
  const dir = mkdtempSync(join(tmpdir(), "freshness-"));
  const monitor = new MonitorStore(join(dir, "monitor.sqlite"));
  const db = new DatabaseSync(join(dir, "crawler.sqlite"));
  const now = Date.parse("2026-11-12T12:00:00Z");
  try {
    db.exec("CREATE TABLE articles(canonical_url TEXT,domain TEXT,published TEXT,classification TEXT,payload TEXT,fetched INTEGER,discovered INTEGER); CREATE TABLE requests(id INTEGER PRIMARY KEY,url TEXT,domain TEXT,purpose TEXT,status INTEGER,error TEXT,finished INTEGER)");
    monitor.configure(providerConfig({}).filter(c => c.id === "google"), now - 100000);
    const job = monitor.claim(now - 100000)!;
    job.site = "bbc.com";
    const items = Array.from({ length: 60 }, (_, i) => sighting("bbc.com", `https://bbc.com/news/${i}`, `Headline number ${i}`, now - 200000)!);
    monitor.success(job, items, 60, false, null, now - 100000);
    for (const [i, item] of items.entries()) {
      const finished = now - 130000 + i * 1000;
      db.prepare("INSERT INTO articles VALUES (?,'bbc.com',?,'new',?,?,?)").run(item.url_raw, new Date(now - 200000).toISOString(), JSON.stringify({ title: item.title }), finished + 10000, finished - 1000);
      db.prepare("INSERT INTO requests VALUES (?,?,'bbc.com','article',200,NULL,?)").run(i + 1, item.url_raw, finished);
    }
    const reader = new CoverageReader(join(dir, "monitor.sqlite"), join(dir, "crawler.sqlite"));
    const first = reader.get(new URLSearchParams(), now, true);
    assert.ok('freshness' in first && first.freshness);
    assert.equal(first.groups.length, 50);
    assert.equal(first.freshness.overall.timed, 60);
    const direct = db.prepare("SELECT finished-? delay FROM requests ORDER BY delay").all(now - 100000);
    for (const [key, fraction] of [["p50", .5], ["p75", .75], ["p90", .9]] as const)
      assert.equal(first.freshness.overall.observed[key], direct[Math.ceil(60 * fraction) - 1].delay);
    const second = reader.get(new URLSearchParams("page=2&matches=unmatched"), now, true);
    assert.ok('freshness' in second);
    assert.deepEqual(second.freshness, first.freshness);
    assert.equal(second.groups.length, 0);
    const zero = reader.get(new URLSearchParams("site=sina.com.cn"), now, true);
    assert.ok('freshness' in zero && zero.freshness);
    assert.equal(zero.freshness.overall.observed.p50, null);
    assert.equal(zero.freshness.domains.length, 1);
    const paired = reader.get(new URLSearchParams('provider=google'), now, true);
    assert.ok('freshness' in paired && paired.freshness);
    assert.equal(paired.freshness.comparison.count, 60);
    const fetchDelays = db.prepare('SELECT finished-? delay FROM requests ORDER BY delay').all(now - 200000);
    for (const [key, fraction] of [["p50", .5], ["p75", .75], ["p90", .9]] as const) {
      assert.equal(paired.freshness.comparison.series[0][key], fetchDelays[Math.ceil(60 * fraction) - 1].delay);
      assert.equal(paired.freshness.comparison.series[1][key], 100000);
    }
    assert.equal(first.freshness.comparison.count, 0); // no Exa observations in this fixture
    const coverage = reader.get(new URLSearchParams(), now);
    assert.ok('freshness' in coverage);
    assert.equal(coverage.freshness, undefined);
    assert.deepEqual(coverage.summary, first.summary);
    for (const window of ["1h", "24h", "7d"]) {
      const result = reader.get(new URLSearchParams({ window, provider: "exa" }), now, true);
      assert.ok('freshness' in result && result.freshness);
      assert.equal(result.freshness.providers.length, 1);
      assert.equal(result.freshness.providers[0].total, 0);
    }
    assert.throws(() => reader.get(new URLSearchParams("window=bad"), now, true), /Invalid/);
    assert.equal(monitor.db.prepare("SELECT count(*) n FROM provider_runs").get()!.n, 1);
  } finally { monitor.db.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('provider comparison uses the same cohort and publication baseline for all three series', async () => {
  const { timingComparison } = await import('./freshness.js');
  const make = (i: number) => {
    const raw = sighting('bbc.com', `https://bbc.com/news/comparison-${i}`, `Distinct comparison headline ${i}`, 1000)!;
    const [group] = matchSightings([
      { ...raw, provider: 'google', site: 'bbc.com', observed_at: 5000 + i * 1000, id: i * 2 },
      { ...raw, provider: 'exa', site: 'bbc.com', observed_at: 7000 + i * 1000, provider_published_at: 2000, id: i * 2 + 1 },
    ], [{ canonical_url: raw.url_raw, domain: 'bbc.com', classification: 'new' }]);
    group.crawler_fetch_finished_at = 3000 + i * 1000;
    return group;
  };
  const included = [0, 1, 2, 3].map(make);
  included[0].incomplete = true;
  included[1].match = 'title';
  // Repeated sightings must not move first observation or add percentile weight.
  included[0].provider_timings.push({ ...included[0].provider_timings[0], observed_at: 99999 });
  const missingFetch = make(4); missingFetch.crawler_fetch_finished_at = null;
  const missingExa = make(5); missingExa.provider_timings = missingExa.provider_timings.filter(t => t.provider !== 'exa');
  const missingDate = make(6); missingDate.provider_timings.forEach(t => { t.published_at = null; });
  const groups = [...included, missingFetch, missingExa, missingDate];
  const result = timingComparison(groups, ['google', 'exa']);
  assert.equal(result.count, 4);
  assert.equal(result.total, 7);
  assert.deepEqual(result.excluded, { missingFetch: 1, missingProviderObservation: 1, missingPublication: 1 });
  assert.deepEqual(result.series, [
    { id: 'crawler', count: 4, p50: 3000, p75: 4000, p90: 5000 },
    { id: 'google', count: 4, p50: 5000, p75: 6000, p90: 7000 },
    { id: 'exa', count: 4, p50: 7000, p75: 8000, p90: 9000 },
  ]);
  assert.equal(result.probable, 1);
  assert.equal(result.incomplete, 1);
  assert.equal(result.differingPublicationDates, 4);
  assert.equal(timingComparison(groups, ['google']).count, 5);
  assert.equal(timingComparison([], ['google', 'exa']).series[0].p50, null);
  const negative = make(7); negative.crawler_fetch_finished_at = 0;
  const anomalous = timingComparison([negative], ['google', 'exa']);
  assert.equal(anomalous.count, 1);
  assert.equal(anomalous.negativeTiming, 1);
  assert.equal(anomalous.series[0].p50, -1000);
});

test('simple freshness uses the earliest known date before windowing, and table delays match card inputs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'publication-delay-'));
  const monitor = new MonitorStore(join(dir, 'monitor.sqlite'));
  const db = new DatabaseSync(join(dir, 'crawler.sqlite'));
  const now = Date.parse('2026-11-12T12:00:00Z');
  try {
    db.exec("CREATE TABLE articles(canonical_url TEXT,domain TEXT,published TEXT,classification TEXT,payload TEXT,fetched INTEGER,discovered INTEGER); CREATE TABLE requests(id INTEGER PRIMARY KEY,url TEXT,domain TEXT,purpose TEXT,status INTEGER,error TEXT,finished INTEGER)");
    const external = (id: string, provider: string, published: number) => {
      const item = sighting('bbc.com', `https://bbc.com/news/${id}`, `A distinct headline for article ${id}`, published)!;
      monitor.db.prepare('INSERT INTO external_sightings(provider,site,item_key,url_raw,url_key,title,title_key,provider_published_at,observed_at,last_observed_at,run_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(provider, 'bbc.com', id, item.url_raw, item.url_key, item.title, item.title_key, published, now - 1000, now - 1000, null);
    };
    const fetched = (id: string, finished: number) => {
      const url = `https://bbc.com/news/${id}`;
      db.prepare("INSERT INTO articles VALUES (?,'bbc.com',?,'new',?,?,?)").run(url, new Date(now - 120000).toISOString(), JSON.stringify({ title: `A distinct headline for article ${id}` }), finished + 1000, finished - 1000);
      db.prepare("INSERT INTO requests(url,domain,purpose,status,finished) VALUES (?,'bbc.com','article',200,?)").run(url, finished);
    };
    external('old', 'google', now - 7200000); external('old', 'exa', now - 60000); fetched('old', now - 30000);
    external('both', 'google', now - 120000); external('both', 'exa', now - 60000); fetched('both', now - 30000);
    external('single', 'google', now - 80000); fetched('single', now - 10000);
    external('missing', 'exa', now - 100000);
    const reader = new CoverageReader(join(dir, 'monitor.sqlite'), join(dir, 'crawler.sqlite'));
    const result = reader.get(new URLSearchParams('window=1h'), now, true);
    assert.ok('freshness' in result && result.freshness);
    assert.equal(result.groupCount, 3);
    assert.deepEqual(result.freshness.overall.published, { count: 2, p50: 70000, p75: 90000, p90: 90000 });
    const rows = result.groups as Array<typeof result.groups[number] & { publication_timing: { publishedAt: number; fetchFinishedAt: number | null; delayMs: number | null; providers: string[] } }>;
    assert.equal(rows.some(g => g.url.endsWith('/old')), false);
    const both = rows.find(g => g.url.endsWith('/both'))!.publication_timing;
    assert.equal(both.publishedAt, now - 120000);
    assert.deepEqual(both.providers, ['google']);
    assert.equal(both.delayMs, both.fetchFinishedAt! - both.publishedAt);
    assert.equal(rows.find(g => g.url.endsWith('/missing'))!.publication_timing.delayMs, null);
    const coverage = reader.get(new URLSearchParams('window=1h'), now);
    assert.equal(coverage.groupCount, 4); // existing Coverage window behavior is unchanged
    const all = reader.get(new URLSearchParams('window=24h'), now, true);
    assert.equal(all.groupCount, 4);
    assert.equal(monitor.db.prepare('SELECT count(*) n FROM provider_runs').get()!.n, 0);
  } finally { monitor.db.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});
