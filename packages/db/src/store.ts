import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export const dataDir = resolve(process.env.CRAWLER_DATA_DIR || 'data');
mkdirSync(dataDir, { recursive: true });
export const db = new DatabaseSync(resolve(dataDir, 'crawler.sqlite'));
db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sites (domain TEXT PRIMARY KEY, started INTEGER NOT NULL, cooldown INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY, domain TEXT NOT NULL, url TEXT NOT NULL, purpose TEXT NOT NULL,
    started INTEGER NOT NULL, finished INTEGER, status INTEGER, error TEXT, body_hash TEXT, headers TEXT
  );
  CREATE INDEX IF NOT EXISTS requests_time ON requests(domain, started);
  CREATE TABLE IF NOT EXISTS robots (origin TEXT PRIMARY KEY, body TEXT NOT NULL, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS sources (
    url TEXT PRIMARY KEY, domain TEXT NOT NULL, kind TEXT NOT NULL, depth INTEGER DEFAULT 0,
    next_poll INTEGER DEFAULT 0, polls INTEGER DEFAULT 0, errors INTEGER DEFAULT 0,
    discovered INTEGER DEFAULT 0, etag TEXT, modified TEXT, last_error TEXT
  );
  CREATE TABLE IF NOT EXISTS candidates (
    url TEXT PRIMARY KEY, domain TEXT NOT NULL, source TEXT NOT NULL, discovered INTEGER NOT NULL,
    published_hint TEXT, priority INTEGER NOT NULL, state TEXT DEFAULT 'pending', attempts INTEGER DEFAULT 0,
    next_attempt INTEGER DEFAULT 0, last_error TEXT
  );
  CREATE INDEX IF NOT EXISTS candidate_queue ON candidates(domain,state,priority,discovered);
  CREATE TABLE IF NOT EXISTS articles (
    canonical_url TEXT PRIMARY KEY, domain TEXT NOT NULL, discovered INTEGER NOT NULL, fetched INTEGER NOT NULL,
    published TEXT, classification TEXT NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS article_fingerprint ON articles(fingerprint);
`);
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
