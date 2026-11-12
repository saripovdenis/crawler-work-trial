import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { sites } from "../../../config/sites.js";
import {
  pollInterval,
  type providerConfig,
  type ProviderId,
} from "../../../config/monitor.js";
import type { Sighting } from "./identity.js";
type Config = ReturnType<typeof providerConfig>[number];
export class MonitorStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS provider_state(provider TEXT PRIMARY KEY,enabled INTEGER,daily_limit INTEGER,total_limit INTEGER,next_call INTEGER DEFAULT 0,note TEXT);
    CREATE TABLE IF NOT EXISTS provider_schedule(provider TEXT,site TEXT,next_poll INTEGER,last_success INTEGER,PRIMARY KEY(provider,site));
    CREATE TABLE IF NOT EXISTS provider_runs(id INTEGER PRIMARY KEY,provider TEXT,site TEXT,started_at INTEGER,finished_at INTEGER,status TEXT,result_count INTEGER DEFAULT 0,accepted_count INTEGER DEFAULT 0,truncated INTEGER DEFAULT 0,quota_used INTEGER DEFAULT 1,cost_usd REAL,window_start INTEGER,window_end INTEGER,error TEXT);
    CREATE INDEX IF NOT EXISTS provider_runs_quota ON provider_runs(provider,started_at);
    CREATE TABLE IF NOT EXISTS external_sightings(id INTEGER PRIMARY KEY,provider TEXT,site TEXT,item_key TEXT,url_raw TEXT,url_key TEXT,title TEXT,title_key TEXT,provider_published_at INTEGER,provider_first_seen_at INTEGER,observed_at INTEGER,last_observed_at INTEGER,run_id INTEGER,UNIQUE(provider,site,item_key));
    CREATE INDEX IF NOT EXISTS sightings_time ON external_sightings(observed_at,site,provider);
    CREATE TABLE IF NOT EXISTS monitor_meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE IF NOT EXISTS audit_candidates(url_key TEXT PRIMARY KEY,url TEXT,domain TEXT,created_at INTEGER,state TEXT DEFAULT 'pending');
  `);
  }
  configure(configs: Config[], now = Date.now()) {
    // Keep removed providers' history and quota ledger, but never schedule them.
    this.db
      .prepare(
        "UPDATE provider_state SET enabled=0,note='Removed from configuration'",
      )
      .run();
    for (const c of configs) {
      this.db
        .prepare(
          `INSERT INTO provider_state(provider,enabled,daily_limit,total_limit,note) VALUES (?,?,?,?,?) ON CONFLICT(provider) DO UPDATE SET enabled=excluded.enabled,daily_limit=excluded.daily_limit,total_limit=excluded.total_limit,note=excluded.note`,
        )
        .run(
          c.id,
          Number(c.enabled && c.scheduled),
          c.daily,
          c.lifetime,
          !c.enabled ? "API key required" : null,
        );
      sites.forEach((site, i) =>
        this.db
          .prepare(
            "INSERT OR IGNORE INTO provider_schedule VALUES (?,?,?,NULL)",
          )
          .run(c.id, site.domain, now + i * 6000),
      );
    }
    this.db
      .prepare(
        "UPDATE provider_runs SET status='interrupted',finished_at=?,error='Monitor restarted; request remains charged' WHERE status='running'",
      )
      .run(now);
  }
  claim(now = Date.now()): {
    id: number;
    provider: ProviderId;
    site: string;
    from: number;
    to: number;
  } | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db
        .prepare(
          `SELECT s.*,p.daily_limit,p.total_limit FROM provider_schedule s JOIN provider_state p USING(provider) WHERE p.enabled=1 AND s.next_poll<=? AND p.next_call<=? ORDER BY s.next_poll,s.provider,s.site`,
        )
        .all(now, now) as any[];
      for (const row of rows) {
        const daily = this.db
          .prepare(
            "SELECT coalesce(sum(quota_used),0) n FROM provider_runs WHERE provider=? AND started_at>=?",
          )
          .get(row.provider, now - 86400000)!.n as number;
        const total = this.db
          .prepare(
            "SELECT coalesce(sum(quota_used),0) n FROM provider_runs WHERE provider=?",
          )
          .get(row.provider)!.n as number;
        if (
          daily >= row.daily_limit ||
          (row.total_limit > 0 && total >= row.total_limit)
        )
          continue;
        const from = Math.max(
          now - 86400000,
          (row.last_success ?? now) - 3600000,
        );
        const id = Number(
          this.db
            .prepare(
              "INSERT INTO provider_runs(provider,site,started_at,status,window_start,window_end) VALUES (?,?,?,'running',?,?)",
            )
            .run(row.provider, row.site, now, from, now).lastInsertRowid,
        );
        this.db
          .prepare(
            "UPDATE provider_schedule SET next_poll=? WHERE provider=? AND site=?",
          )
          .run(now + pollInterval, row.provider, row.site);
        this.db
          .prepare("UPDATE provider_state SET next_call=? WHERE provider=?")
          .run(now + 6000, row.provider);
        this.db.exec("COMMIT");
        return { id, provider: row.provider, site: row.site, from, to: now };
      }
      this.db.exec("COMMIT");
      return null;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  success(
    job: { id: number; provider: ProviderId; site: string; to: number },
    items: Sighting[],
    rawCount: number,
    truncated: boolean,
    cost: number | null,
    now = Date.now(),
  ) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const item of items) {
        if (item.url_key)
          this.db
            .prepare(
              "INSERT OR IGNORE INTO audit_candidates(url_key,url,domain,created_at) VALUES (?,?,?,?)",
            )
            .run(item.url_key, item.url_raw, job.site, now);
        const identity =
          item.url_key ||
          item.url_raw ||
          `${item.title_key}:${item.provider_published_at}`;
        const key = createHash("sha256").update(identity).digest("hex");
        this.db
          .prepare(
            `INSERT INTO external_sightings(provider,site,item_key,url_raw,url_key,title,title_key,provider_published_at,provider_first_seen_at,observed_at,last_observed_at,run_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(provider,site,item_key) DO UPDATE SET last_observed_at=excluded.last_observed_at`,
          )
          .run(
            job.provider,
            job.site,
            key,
            item.url_raw,
            item.url_key,
            item.title,
            item.title_key,
            item.provider_published_at,
            item.provider_first_seen_at,
            now,
            now,
            job.id,
          );
      }
      this.db
        .prepare(
          "UPDATE provider_runs SET status='ok',finished_at=?,result_count=?,accepted_count=?,truncated=?,cost_usd=? WHERE id=?",
        )
        .run(now, rawCount, items.length, Number(truncated), cost, job.id);
      this.db
        .prepare(
          "UPDATE provider_schedule SET last_success=? WHERE provider=? AND site=?",
        )
        .run(job.to, job.provider, job.site);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  failure(
    job: { id: number; provider: ProviderId },
    error: string,
    retryAt: number | null,
    now = Date.now(),
  ) {
    this.db
      .prepare(
        "UPDATE provider_runs SET status='error',finished_at=?,error=? WHERE id=?",
      )
      .run(now, error.slice(0, 300), job.id);
    if (retryAt)
      this.db
        .prepare(
          "UPDATE provider_state SET next_call=max(next_call,?) WHERE provider=?",
        )
        .run(retryAt, job.provider);
  }
}
