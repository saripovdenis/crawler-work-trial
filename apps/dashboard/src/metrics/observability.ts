import { DatabaseSync } from "../../../../packages/pg/src/sync.js";
import { readFile } from "node:fs/promises";
import { createBodyStore } from "../../../../packages/protocol/src/body-store.js";
import { resolve } from "node:path";
import { sites } from "../../../../config/sites.js";
import { LruCache } from "../../../../packages/core/src/lru.js";
import { PARSER_VERSION } from "../../../../packages/core/src/parser-version.js";
import { nextAllowed } from "../../../../packages/core/src/policy.js";

type Row = Record<string, any>;
export class Observatory {
  readonly db: DatabaseSync;
  private details = new LruCache<string, Row>(64,8*1024*1024);
  private cached: { at: number; value: unknown } | undefined;
  constructor(readonly directory: string) {
    this.db = new DatabaseSync(resolve(directory, "crawler.sqlite"), {
      readOnly: true,
    });
    this.db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=2000");
  }
  all(sql: string, ...params: (string | number)[]): Row[] {
    return this.db.prepare(sql).all(...params);
  }
  one(sql: string, ...params: (string | number)[]): Row {
    return this.db.prepare(sql).get(...params) || {};
  }
  overview() {
    if (this.cached && Date.now() - this.cached.at < 30_000)
      return this.cached.value;
    const now = Date.now();
    const meta = Object.fromEntries(
      this.all("SELECT * FROM meta").map((r) => [r.key, r.value]),
    );
    const sourceRows = this.all(
      "SELECT domain,count(*) AS total,sum(errors=0 AND polls>0) AS healthy,min(next_poll) AS next_poll FROM sources GROUP BY domain",
    );
    const articleRows = this.all(
      "SELECT domain,count(*) AS total,sum(classification='new') AS fresh FROM articles GROUP BY domain",
    );
    const requestRows = this.all(
      "SELECT domain,count(*) AS total,sum(status>=400 OR error IS NOT NULL) AS errors,max(started) AS last_request FROM requests GROUP BY domain",
    );
    const minuteRows = this.all(
      "SELECT domain,count(*) AS n FROM requests WHERE started>? GROUP BY domain",
      now - 60_000,
    );
    const queueRows = this.all(
      "SELECT domain,count(*) AS total,sum(priority>0) AS ready FROM candidates WHERE state='pending' GROUP BY domain",
    );
    const staleRows = this.all(
      "SELECT domain,count(*) AS n FROM candidates WHERE state='stale' GROUP BY domain",
    );
    const configurations = this.all("SELECT * FROM sites");
    const perSite = sites.map((site) => {
      const r = requestRows.find((r) => r.domain === site.domain) || {};
      const s = sourceRows.find((r) => r.domain === site.domain) || {};
      const a = articleRows.find((r) => r.domain === site.domain) || {};
      const c = configurations.find((r) => r.domain === site.domain) || {};
      const q = queueRows.find((r) => r.domain === site.domain) || {};
      const recent = this.all(
        "SELECT started FROM requests WHERE domain=? ORDER BY id DESC LIMIT 61",
        site.domain,
      )
        .reverse()
        .map((r) => r.started);
      const availableAt = Math.max(
        c.cooldown || 0,
        nextAllowed(now, c.started || 0, site.requestsPerMinute, recent),
      );
      const error = this.one(
        "SELECT last_error FROM sources WHERE domain=? AND last_error IS NOT NULL ORDER BY next_poll DESC LIMIT 1",
        site.domain,
      ).last_error;
      return {
        ...site,
        requests: r.total || 0,
        errors: r.errors || 0,
        lastRequest: r.last_request || null,
        usedThisMinute:
          minuteRows.find((r) => r.domain === site.domain)?.n || 0,
        currentLimit:
          now < (c.started || 0) + 600_000 ? 60 : site.requestsPerMinute,
        sources: s.total || 0,
        healthySources: s.healthy || 0,
        articles: a.total || 0,
        fresh: a.fresh || 0,
        queued: q.total || 0,
        priorityQueued: q.ready || 0,
        stale: staleRows.find((r) => r.domain === site.domain)?.n || 0,
        nextEligible: Math.max(availableAt, s.next_poll || now),
        lastError: error || null,
        health: !s.healthy
          ? "blocked"
          : s.healthy < s.total
            ? "degraded"
            : "healthy",
      };
    });
    const delays = this.all(
      "SELECT (discovered - extract(epoch FROM published::timestamptz)*1000)/1000 AS delay FROM articles WHERE classification='new' AND published IS NOT NULL ORDER BY delay",
    )
      .map((r) => r.delay)
      .filter((n) => n >= 0);
    const percentile = (p: number) =>
      delays.length
        ? Math.round(
            delays[Math.min(delays.length - 1, Math.floor(delays.length * p))],
          )
        : null;
    const rawSeries = this.all(
      "SELECT CAST(started/300000 AS INTEGER)*300000 AS time,count(*) AS requests,sum(status>=400 OR error IS NOT NULL) AS errors FROM requests WHERE started>? GROUP BY time",
      now - 3600_000,
    );
    const freshSeries = this.all(
      "SELECT CAST(fetched/300000 AS INTEGER)*300000 AS time,count(*) AS fresh FROM articles WHERE classification='new' AND fetched>? GROUP BY time",
      now - 3600_000,
    );
    const series = Array.from({ length: 12 }, (_, i) => {
      const time = Math.floor(now / 300_000) * 300_000 - (11 - i) * 300_000;
      return {
        time,
        requests: 0,
        errors: 0,
        fresh: 0,
        ...rawSeries.find((r) => r.time === time),
        ...freshSeries.find((r) => r.time === time),
      };
    });
    const value = {
      generatedAt: now,
      startedAt: meta.started,
      heartbeat: meta.heartbeat,
      running: !!meta.heartbeat && now - Date.parse(meta.heartbeat) < 120_000,
      totals: {
        requests: perSite.reduce((n, s) => n + s.requests, 0),
        articles: perSite.reduce((n, s) => n + s.articles, 0),
        fresh: perSite.reduce((n, s) => n + s.fresh, 0),
        errors: perSite.reduce((n, s) => n + s.errors, 0),
        healthySites: perSite.filter((s) => s.health === "healthy").length,
        respondingSites: perSite.filter((s) => s.healthySources > 0).length,
        p50Delay: percentile(0.5),
        p95Delay: percentile(0.95),
        delaySamples: delays.length,
      },
      series,
      sites: perSite,
      coverage: "Not measured",
      version: "1.0.0",
    };
    this.cached = { at: Date.now(), value };
    return value;
  }
  filter(params: URLSearchParams) {
    const domain = params.get("domain") || "";
    if (domain && !sites.some((s) => s.domain === domain))
      throw new Error("Invalid domain");
    const cursor = Number(params.get("before") || 0);
    if (!Number.isSafeInteger(cursor) || cursor < 0)
      throw new Error("Invalid cursor");
    return { domain, cursor };
  }
  requests(params: URLSearchParams) {
    const { domain, cursor } = this.filter(params);
    const conditions: string[] = [];
    const values: (string | number)[] = [];
    if (domain) {
      conditions.push("domain=?");
      values.push(domain);
    }
    if (cursor) {
      conditions.push("id<?");
      values.push(cursor);
    }
    if (params.get("errors") === "true")
      conditions.push("(status>=400 OR error IS NOT NULL)");
    const rows = this.all(
      `SELECT id,domain,url,purpose,started,finished,status,error,body_hash IS NOT NULL AS hasSnapshot FROM requests ${conditions.length ? "WHERE " + conditions.join(" AND ") : ""} ORDER BY id DESC LIMIT 60`,
      ...values,
    );
    return {
      items: rows,
      nextCursor: rows.length === 60 ? rows.at(-1)!.id : null,
    };
  }
  articles(params: URLSearchParams) {
    const { domain, cursor } = this.filter(params);
    const conditions: string[] = [];
    const values: (string | number)[] = [];
    if (domain) {
      conditions.push("domain=?");
      values.push(domain);
    }
    if (cursor) {
      conditions.push("rowid<?");
      values.push(cursor);
    }
    if (params.get("fresh") === "true") conditions.push("classification='new'");
    const search = (params.get("q") || "").slice(0, 100);
    if (search) {
      conditions.push("json_extract(payload,'$.title') ILIKE ?");
      values.push("%" + search + "%");
    }
    const rows = this.all(
      `SELECT rowid AS id,canonical_url AS url,domain,discovered,fetched,published,classification,
      json_extract(payload,'$.title') AS title,substr(json_extract(payload,'$.description'),1,400) AS description,
      json_extract(payload,'$.dateSource') AS dateSource,length(json_extract(payload,'$.text')) AS textLength
      FROM articles ${conditions.length ? "WHERE " + conditions.join(" AND ") : ""} ORDER BY rowid DESC LIMIT 60`,
      ...values,
    );
    return {
      items: rows,
      nextCursor: rows.length === 60 ? rows.at(-1)!.id : null,
    };
  }
  sources(params: URLSearchParams) {
    const { domain } = this.filter(params);
    return {
      items: this.all(
        `SELECT url,domain,kind,next_poll AS nextEligible,polls,errors,discovered,last_error AS lastError FROM sources ${domain ? "WHERE domain=?" : ""} ORDER BY next_poll ASC,url LIMIT 500`,
        ...(domain ? [domain] : []),
      ),
    };
  }
  async requestDetail(id: number) {
    const row = this.one(
      "SELECT id,domain,url,purpose,started,finished,status,error,body_hash FROM requests WHERE id=?",
      id,
    );
    if (!row.id) return null;
    const { body_hash, ...safe } = row;
    const detail: Row = {
      ...safe,
      links: [],
      linkCount: 0,
      snapshotAvailable: false,
    };
    if (
      !body_hash ||
      !/^[a-f0-9]{64}$/.test(body_hash) ||
      row.purpose !== "discovery"
    )
      return detail;
    try {
      const headers = this.one("SELECT headers FROM requests WHERE id=?", id).headers;
      const charset = JSON.parse(headers || "{}")["content-type"]?.match(/charset=["']?([^;"'\s]+)/i)?.[1] || "utf-8";
      const kind = this.one("SELECT kind FROM sources WHERE url=?", row.url).kind || (/xml|rss|sitemap/i.test(row.url) ? "sitemap" : "html");
      const key=JSON.stringify([body_hash,row.url,kind,charset,PARSER_VERSION,Math.floor(Date.now()/86400000)]);
      const cached=this.details.get(key);
      if(cached)return {...detail,...cached};
      const bytes=createBodyStore(this.directory).readVerified(body_hash);
      let body;
      try {body=new TextDecoder(charset).decode(bytes);} catch {body=bytes.toString("utf8");}
      const { discover }=await import("../../../../packages/core/src/parse.js");
      const result = discover(body, row.url, kind);
      detail.snapshotAvailable = true;
      detail.linkCount = result.articles.length;
      detail.links = result.articles.slice(0, 200);
      detail.sources = result.sources.slice(0, 30);
      if(row.finished) {
        const snapshot={snapshotAvailable:true,linkCount:detail.linkCount,links:detail.links,sources:detail.sources};
        this.details.set(key,snapshot,Buffer.byteLength(JSON.stringify(snapshot)));
      }
    } catch {
      detail.snapshotNote = "No readable discovery snapshot for this response.";
    }
    return detail;
  }
}
