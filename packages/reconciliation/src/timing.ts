import type { DatabaseSync } from "node:sqlite";
import type { Group } from "./view.js";
import { date } from "./identity.js";

// The article's fetched column is parse completion, not network completion.
// Use the worker receipt when available; older requests predate that contract.
export function attachFetchTiming(db: DatabaseSync, groups: Group[]) {
  const matched = groups.filter((g) => g.article_url);
  if (
    !matched.length ||
    !db.prepare("SELECT 1 FROM sqlite_master WHERE name='requests'").get()
  )
    return;
  const durable = !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE name='attempt_assignments'")
    .get();
  const domains = [...new Set(matched.map((g) => g.site))];
  const rows = db
    .prepare(
      `SELECT r.id,r.url,r.finished,r.domain,
    ${durable ? "a.attempt_id,a.completion,a.processing,t.url source_url" : "NULL attempt_id,NULL completion,NULL processing,NULL source_url"}
    FROM requests r ${durable ? "LEFT JOIN attempt_assignments a ON a.request_id=r.id LEFT JOIN crawl_tasks t ON t.id=a.task_id" : ""}
    WHERE r.purpose='article' AND r.status=200 AND r.error IS NULL AND r.finished IS NOT NULL
    AND r.domain IN (${domains.map(() => "?").join(",")}) ORDER BY r.finished,r.id`,
    )
    .all(...domains);
  const byUrl = new Map<string, typeof rows>();
  for (const row of rows) {
    // A durable response must have completed parsing successfully.
    if (row.attempt_id && row.processing !== "done") continue;
    for (const url of new Set([row.source_url, row.url].filter(Boolean))) {
      const key = `${row.domain}|${url}`;
      const list = byUrl.get(key) || [];
      list.push(row);
      byUrl.set(key, list);
    }
  }
  for (const g of matched) {
    const source = g.crawler_source_url || g.article_url;
    const row = (byUrl.get(`${g.site}|${source}`) || []).find(
      (r) =>
        g.crawler_parsed_at !== null &&
        Number(r.finished) <= g.crawler_parsed_at,
    );
    if (!row) continue;
    let finished: number | null = null;
    if (row.attempt_id) {
      try {
        finished = date(JSON.parse(String(row.completion)).finished_at);
      } catch {
        /* unknown receipt */
      }
      g.crawler_fetch_time_source = finished === null ? null : "worker_receipt";
    } else {
      finished = Number(row.finished);
      g.crawler_fetch_time_source = "legacy_request_finished";
    }
    // Malformed historical timestamps stay unknown instead of inventing a delay.
    if (
      finished === null ||
      !Number.isFinite(finished) ||
      finished > Number(row.finished)
    )
      continue;
    g.crawler_fetch_finished_at = finished;
    g.crawler_request_id = Number(row.id);
    for (const p of g.provider_timings) {
      p.fetch_minus_observed_ms = finished - p.observed_at;
      p.fetch_minus_published_ms =
        p.published_at === null ? null : finished - p.published_at;
    }
  }
}
