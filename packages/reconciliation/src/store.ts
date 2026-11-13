import { DatabaseSync } from "../../pg/src/sync.js";
import { ensureSchema } from "../../pg/src/schema.js";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { sites } from "../../../config/sites.js";
import {
  pollInterval,
  pollLookback,
  type providerConfig,
  type ProviderId,
} from "../../../config/monitor.js";
import type { Sighting } from "./identity.js";
type Config = ReturnType<typeof providerConfig>[number];
export class MonitorStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    // The path now only names this service's lock file; rows live in PostgreSQL.
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync();
    ensureSchema(this.db);
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
      // Apply a shorter cadence from the last charged attempt, never from restart.
      // Keep provider cooldowns and all quota reservations intact.
      this.db
        .prepare(
          `UPDATE provider_schedule SET next_poll=least(next_poll,
        coalesce((SELECT max(started_at) FROM provider_runs r
          WHERE r.provider=provider_schedule.provider AND r.site=provider_schedule.site)+?,next_poll))
        WHERE provider=?`,
        )
        .run(pollInterval, c.id);
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
          (row.last_success ?? now) - pollLookback,
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
            `INSERT INTO external_sightings(provider,site,item_key,url_raw,url_key,title,title_key,provider_published_at,provider_first_seen_at,observed_at,last_observed_at,run_id,source_host) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(provider,site,item_key) DO UPDATE SET last_observed_at=excluded.last_observed_at,source_host=coalesce(external_sightings.source_host,excluded.source_host)`,
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
            item.source_host ?? null,
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
          "UPDATE provider_state SET next_call=greatest(next_call,?) WHERE provider=?",
        )
        .run(retryAt, job.provider);
  }
}
