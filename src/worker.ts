import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { get, run, dataDir } from '../packages/db/src/store.js';
import { request, signal, pause, Denied } from './http.js';
import { discover, parseArticle } from '../packages/core/src/parse.js';
import { classify, domainFor } from '../packages/core/src/policy.js';
import type { SiteConfig } from '../packages/core/src/types.js';

type SourceRow = { url: string; kind: string; polls: number; errors: number; depth: number; etag: string | null; modified: string | null };
type Candidate = { url: string; discovered: number; published_hint: string | null; attempts: number };
export const log = (event: string, data: object) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));

async function poll(site: SiteConfig, source: SourceRow, started: number) {
  const interval = Math.max(30_000, Math.ceil(180_000 / site.requestsPerMinute));
  try {
    const headers: Record<string, string> = {};
    if (source.etag) headers['If-None-Match'] = source.etag;
    if (source.modified) headers['If-Modified-Since'] = source.modified;
    const res = await request(source.url, 'discovery', headers);
    if (res.status !== 304 && res.status !== 200) throw new Error(`HTTP ${res.status}`);
    let count = 0;
    if (res.status === 200) {
      const found = discover(res.body, res.url, source.kind);
      for (const child of found.sources) {
        if (domainFor(child.url) !== site.domain || source.depth >= 3) continue;
        const n = get<{ n: number }>('SELECT count(*) AS n FROM sources WHERE domain=?', site.domain)!.n;
        if (n < 18) run('INSERT OR IGNORE INTO sources(url,domain,kind,depth) VALUES (?,?,?,?)', child.url, site.domain, child.kind, source.depth + 1);
      }
      const now = Date.now();
      for (const item of found.articles) {
        if (domainFor(item.url) !== site.domain) continue;
        const publication = item.published ? Date.parse(item.published) : null;
        const priority = publication !== null ? (publication >= started ? 100 : -10) : source.polls > 0 ? 50 : 0;
        count += Number(run(`INSERT OR IGNORE INTO candidates(url,domain,source,discovered,published_hint,priority)
          VALUES (?,?,?,?,?,?)`, item.url, site.domain, source.url, now, item.published, priority).changes);
        if (item.published) run(`UPDATE candidates SET published_hint=coalesce(published_hint,?),priority=max(priority,?) WHERE url=? AND state='pending'`, item.published, priority, item.url);
      }
    }
    run(`UPDATE sources SET polls=polls+1,errors=0,last_error=NULL,next_poll=?,discovered=discovered+?,etag=coalesce(?,etag),modified=coalesce(?,modified) WHERE url=?`,
      Date.now() + interval * (source.kind === 'sitemap' ? 2 : 1), count, res.headers.get('etag'), res.headers.get('last-modified'), source.url);
    log('source', { site: site.domain, url: source.url, status: res.status, added: count });
  } catch (error) {
    if (signal.aborted) return;
    const wait = error instanceof Denied ? 3600_000 : Math.min(3600_000, 30_000 * 2 ** source.errors);
    run('UPDATE sources SET errors=errors+1,next_poll=?,last_error=? WHERE url=?', Date.now() + wait, String(error), source.url);
    log('source_error', { site: site.domain, url: source.url, error: String(error) });
  }
}

async function fetchArticle(site: SiteConfig, item: Candidate, started: number) {
  try {
    const res = await request(item.url, 'article');
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const article = parseArticle(res.body, res.url, item.discovered, item.published_hint);
    const fingerprint = createHash('sha256').update(article.text).digest('hex');
    const duplicate = !!get('SELECT 1 FROM articles WHERE fingerprint=? AND canonical_url<>?', fingerprint, article.canonicalUrl);
    const classification = classify(article.publishedAt, started, item.discovered, duplicate, article.isArticle && article.text.length >= 200 && article.title.length > 0);
    const payload = { ...article, classification, fetchedAt: new Date().toISOString(), sourceUrl: item.url, domain: site.domain };
    const saved = run(`INSERT OR IGNORE INTO articles(canonical_url,domain,discovered,fetched,published,classification,fingerprint,payload)
      VALUES (?,?,?,?,?,?,?,?)`, article.canonicalUrl, site.domain, item.discovered, Date.now(), article.publishedAt, classification, fingerprint, JSON.stringify(payload));
    if (saved.changes) {
      appendFileSync(resolve(dataDir, 'articles.jsonl'), JSON.stringify(payload) + '\n');
      if (classification === 'new') appendFileSync(resolve(dataDir, 'new-articles.jsonl'), JSON.stringify(payload) + '\n');
    }
    run("UPDATE candidates SET state='done',attempts=attempts+1,last_error=NULL WHERE url=?", item.url);
    log('article', { site: site.domain, classification, title: article.title, url: article.canonicalUrl });
  } catch (error) {
    if (signal.aborted) return;
    const terminal = error instanceof Denied || /HTTP (404|410)/.test(String(error)) || item.attempts >= 2;
    run('UPDATE candidates SET state=?,attempts=attempts+1,next_attempt=?,last_error=? WHERE url=?', terminal ? 'failed' : 'pending', Date.now() + 60_000 * 2 ** item.attempts, String(error), item.url);
    log('article_error', { site: site.domain, url: item.url, error: String(error) });
  }
}

export async function worker(site: SiteConfig) {
  const started = get<{ started: number }>('SELECT started FROM sites WHERE domain=?', site.domain)!.started;
  let articlesSincePoll = 2;
  while (!signal.aborted) {
    const baselineFetched = get<{ n: number }>("SELECT count(*) AS n FROM candidates WHERE domain=? AND priority=0 AND state<>'pending'", site.domain)!.n;
    const candidate = get<Candidate>(`SELECT * FROM candidates WHERE domain=? AND state='pending' AND next_attempt<=?
      AND (priority>0 OR (priority=0 AND ?<8)) ORDER BY priority DESC,discovered DESC,rowid ASC LIMIT 1`, site.domain, Date.now(), baselineFetched);
    const source = get<SourceRow>(`SELECT * FROM sources WHERE domain=? AND next_poll<=?
      ORDER BY CASE WHEN polls=0 AND errors=0 THEN 0 ELSE 1 END, next_poll ASC LIMIT 1`, site.domain, Date.now());
    if (source && (articlesSincePoll >= 2 || !candidate)) {
      await poll(site, source, started);
      articlesSincePoll = 0;
    } else if (candidate) {
      await fetchArticle(site, candidate, started);
      articlesSincePoll++;
    } else await pause(1000);
  }
}
