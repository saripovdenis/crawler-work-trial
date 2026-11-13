import { DatabaseSync } from '../../pg/src/sync.js';
import { mkdirSync } from 'node:fs';
import { ensureSchema } from '../../pg/src/schema.js';
import { resolve } from 'node:path';

export const dataDir = resolve(process.env.CRAWLER_DATA_DIR || 'data');
mkdirSync(dataDir, { recursive: true });
// The data directory still holds archives, receipts and status files; rows live in PostgreSQL.
export const db = new DatabaseSync();
ensureSchema(db);
export function get<T>(sql: string, ...args: (string | number | null)[]): T | undefined {
  return db.prepare(sql).get(...args) as T | undefined;
}
export function all<T>(sql: string, ...args: (string | number | null)[]): T[] {
  return db.prepare(sql).all(...args) as T[];
}
export function run(sql: string, ...args: (string | number | null)[]) {
  return db.prepare(sql).run(...args);
}

export function summary() {
  return {
    collectedAt: new Date().toISOString(),
    firstStartedAt: get<{ value: string }>("SELECT value FROM meta WHERE key='started'")?.value,
    heartbeat: get<{ value: string }>("SELECT value FROM meta WHERE key='heartbeat'")?.value,
    sites: all(`SELECT s.domain,
      (SELECT count(*) FROM requests r WHERE r.domain=s.domain) AS requests,
      (SELECT count(*) FROM requests r WHERE r.domain=s.domain AND (r.error IS NOT NULL OR r.status>=400)) AS failed_requests,
      (SELECT count(*) FROM sources x WHERE x.domain=s.domain AND x.errors<5) AS active_sources,
      (SELECT count(*) FROM candidates c WHERE c.domain=s.domain AND c.state='pending') AS pending,
      coalesce(a.parsed,0) AS parsed,
      coalesce(a.new_articles,0) AS new_articles,
      (SELECT error FROM requests r WHERE r.domain=s.domain AND r.error IS NOT NULL ORDER BY id DESC LIMIT 1) AS last_error
      FROM sites s LEFT JOIN (SELECT domain,count(*) parsed,sum(classification='new') new_articles FROM articles GROUP BY domain) a ON a.domain=s.domain ORDER BY s.domain`),
    classifications: all('SELECT classification,count(*) AS count FROM articles GROUP BY classification'),
    coverage: 'Unknown: no independent ground-truth article list yet.',
    delay: all(`SELECT domain, count(*) AS samples,
      round(avg((discovered - unixepoch(published)*1000)/1000.0),1) AS average_seconds,
      round(max((discovered - unixepoch(published)*1000)/1000.0),1) AS maximum_seconds
      FROM articles WHERE classification='new' GROUP BY domain`),
  };
}
