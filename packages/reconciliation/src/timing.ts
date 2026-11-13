import type { DatabaseSync } from "../../pg/src/sync.js";
import { date, urlKey } from "./identity.js";

type Row = Record<string, any>;

// Successful article downloads define coverage. Parsed rows only enrich them;
// a pending/failed parse must not hide an already archived HTTP 200 response.
export function fetchedArticles(db: DatabaseSync, articles: Row[], site: string, now: number): Row[] {
  const durable = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='attempt_assignments'").get();
  const rows = db.prepare(`SELECT r.id,r.url,r.finished,r.domain,
    ${durable ? "a.attempt_id,a.completion,t.url source_url" : "NULL attempt_id,NULL completion,NULL source_url"}
    FROM requests r ${durable ? "LEFT JOIN attempt_assignments a ON a.request_id=r.id LEFT JOIN crawl_tasks t ON t.id=a.task_id" : ""}
    WHERE r.purpose='article' AND r.status=200 AND r.error IS NULL
    AND r.body_hash IS NOT NULL AND r.finished IS NOT NULL AND r.finished<=?
    AND (?='' OR r.domain=?) ORDER BY r.finished,r.id`).all(now,site,site) as Row[];
  const parsed = new Map<string, Row>();
  for (const article of articles) {
    for (const url of [article.canonical_url,article.source_url]) {
      const key = url && urlKey(url);
      if (key) parsed.set(article.domain+'|'+key,article);
    }
  }
  const found = new Map<string, Row>();
  for (const row of rows) {
    const source = row.source_url || row.url;
    const article = parsed.get(row.domain+'|'+urlKey(source)) || parsed.get(row.domain+'|'+urlKey(row.url));
    const canonical = article?.canonical_url || row.url;
    const key = row.domain+'|'+urlKey(canonical);
    const existing = found.get(key);
    if (existing) {
      existing.match_urls.push(source,row.url);
      continue;
    }
    let finished: number | null = null;
    if (row.attempt_id) {
      try { const receipt=JSON.parse(row.completion); finished = date(receipt.fetch_finished_at ?? receipt.finished_at); } catch { /* unknown receipt */ }
    } else finished = Number(row.finished);
    if (finished !== null && (!Number.isFinite(finished) || finished > Number(row.finished))) finished = null;
    found.set(key, {
      ...(article || {}), canonical_url:canonical, domain:row.domain,
      source_url:source, match_urls:[source,row.url,article?.source_url].filter(Boolean),
      fetch_finished_at:finished,
      fetch_time_source:finished === null ? null : row.attempt_id ? 'worker_receipt' : 'legacy_request_finished',
      request_id:Number(row.id),
    });
  }
  return [...found.values()];
}
