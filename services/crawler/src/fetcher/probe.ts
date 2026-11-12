import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { setTimeout as sleep } from 'node:timers/promises';
import { db, get, run, dataDir } from '../../../../packages/db/src/store.js';
import { domainFor } from '../../../../packages/core/src/policy.js';
import { reserveSlot } from '../scheduler/budget.js';
import { sites } from '../../../../config/sites.js';
import { discover, parseArticle } from '../../../../packages/core/src/parse.js';
import { assertProbeWindow } from './probe-safety.js';

const robotsParser: typeof import('robots-parser').default = createRequire(import.meta.url)('robots-parser');
const headers = { 'User-Agent': 'ExaTrialCrawler/0.1', Accept: 'text/html,application/xml,application/rss+xml,*/*;q=0.5' };
const allowed = new Set(['hoodline.com', 'eleconomista.es']);
const profiles = ['node', 'cffi-crawler', 'cffi-chrome'] as const;
type Profile = typeof profiles[number];
type Response = { status: number; headers: Record<string, string>; body: Buffer; version?: string; impersonate?: string; httpVersion?: number };
const deadline = Date.now() + 10 * 60_000;
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const counts = new Map<string, number>();
mkdirSync(resolve(dataDir, 'probes'), { recursive: true });
mkdirSync(resolve(dataDir, 'snapshots'), { recursive: true });

async function reserve(url: string, profile: Profile) {
  const domain = domainFor(url);
  if (!domain || !allowed.has(domain)) throw new Error('Probe outside the two approved test sites');
  const rpm = sites.find(s => s.domain === domain)!.requestsPerMinute;
  while (true) {
    const now = Date.now();
    const sources = get<{ sources: number; healthy: number; nextPoll: number | null }>(
      'SELECT count(*) sources,sum(errors=0) healthy,min(next_poll) nextPoll FROM sources WHERE domain=?', domain)!;
    const pending = get<{ n: number }>("SELECT count(*) n FROM candidates WHERE domain=? AND state='pending'", domain)!.n;
    const unfinished = get<{ n: number }>('SELECT count(*) n FROM requests WHERE domain=? AND finished IS NULL', domain)!.n;
    assertProbeWindow({ ...sources, pending, unfinished }, now, deadline);
    if ((counts.get(domain) || 0) >= 6) throw new Error('Six-request per-site experiment cap reached');
    const robots = get<{ body: string; expires: number }>('SELECT * FROM robots WHERE origin=?', new URL(url).origin);
    if (!robots || robots.expires < deadline) throw new Error('Fresh cached robots policy required');
    const rules = robotsParser(`${new URL(url).origin}/robots.txt`, robots.body);
    if (rules.isAllowed(url, headers['User-Agent']) === false || rules.isAllowed(url, 'Mozilla/5.0') === false)
      throw new Error('robots.txt disallows probe');
    const slot = reserveSlot(db, domain, url, `probe-${profile}`, rpm, rules.getCrawlDelay(headers['User-Agent']) || 0);
    if (slot.id !== undefined) {
      counts.set(domain, (counts.get(domain) || 0) + 1);
      return { id: slot.id, domain, started: now };
    }
    const wait = Math.max(1, slot.due - Date.now());
    if (Date.now() + wait + 30_000 >= deadline) throw new Error('Budget unavailable before deadline');
    await sleep(wait);
  }
}

async function transport(url: string, profile: Profile): Promise<Response> {
  if (profile !== 'node') {
    return new Promise((accept, reject) => {
      const child = execFile(process.env.PROBE_PYTHON || 'python3', [resolve('services/fetcher-impersonate/cffi-fetch.py')],
        { timeout: 25_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
          if (error) return reject(error);
          try {
            const r = JSON.parse(stdout);
            if (r.error) throw new Error(r.error);
            accept({ ...r, body: Buffer.from(r.body, 'base64') });
          } catch (e) { reject(e); }
        });
      child.stdin!.end(JSON.stringify({ url, profile, headers: profile === 'cffi-crawler' ? headers : {} }));
    });
  }
  const response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body) for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 5 * 1024 * 1024) throw new Error('Response exceeds 5 MiB');
    chunks.push(chunk);
  }
  return { status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.concat(chunks), version: process.version };
}

async function probe(initial: string, profile: Profile) {
  let url = initial;
  for (let hop = 0; hop < 3; hop++) {
    const { id, domain, started } = await reserve(url, profile);
    try {
      const response = await transport(url, profile);
      const finished = Date.now();
      const h = new Headers(response.headers);
      const hash = createHash('sha256').update(response.body).digest('hex');
      const path = resolve(dataDir, 'snapshots', `${hash}.gz`);
      if (!existsSync(path)) writeFileSync(path, gzipSync(response.body));
      run('UPDATE requests SET finished=?,status=?,headers=?,body_hash=? WHERE id=?', finished, response.status, JSON.stringify(response.headers), hash, id);
      if ([429, 503].includes(response.status)) {
        const retry = h.get('retry-after') || '300';
        const until = /^\d+$/.test(retry) ? finished + Number(retry) * 1000 : Date.parse(retry);
        run('UPDATE sites SET cooldown=max(cooldown,?) WHERE domain=?', Math.max(finished + 60_000, until || 0), domain);
      }
      const charset = h.get('content-type')?.match(/charset=["']?([^;"'\s]+)/i)?.[1] || 'utf-8';
      let body: string;
      try { body = new TextDecoder(charset).decode(response.body); } catch { body = response.body.toString('utf8'); }
      const challenge = h.get('cf-mitigated') === 'challenge' || /<title>\s*(Just a moment|Access Denied)/i.test(body);
      const found = response.status === 200 && !challenge ? discover(body, url, 'html') : { articles: [], sources: [] };
      const article = response.status === 200 && !challenge ? parseArticle(body, url, finished, null) : null;
      const result = {
        runId, id, url, profile, status: response.status, bytes: response.body.length,
        durationMs: finished - started, started: new Date(started).toISOString(),
        version: response.version, impersonate: response.impersonate, httpVersion: response.httpVersion,
        server: h.get('server'), challenge, bodyHash: hash,
        title: body.match(/<title[^>]*>([^<]*)/i)?.[1]?.slice(0, 180),
        candidates: found.articles.length, sampleUrls: found.articles.slice(0, 3).map(a => a.url),
        article: article && { isArticle: article.isArticle, title: article.title, published: article.publishedAt,
          textLength: article.text.length, socialTagCount: Object.keys(article.socialTags).length },
      };
      appendFileSync(resolve(dataDir, 'probes', `${runId}.jsonl`), JSON.stringify(result) + '\n');
      console.log(JSON.stringify(result));
      if ([429, 503].includes(response.status)) throw new Error('Probe stopped after server backoff response');
      if (response.status >= 300 && response.status < 400 && response.status !== 304 && h.get('location')) {
        url = new URL(h.get('location')!, url).href;
        continue;
      }
      return;
    } catch (e) {
      run('UPDATE requests SET finished=?,error=? WHERE id=?', Date.now(), String(e), id);
      throw e;
    }
  }
  throw new Error('Three-hop experiment limit reached');
}

try {
  const [profile, url] = process.argv.slice(2);
  if (profile || url) {
    if (!profiles.includes(profile as Profile) || !url) throw new Error('Usage: probe.ts [node|cffi-crawler|cffi-chrome URL]');
    await probe(url, profile as Profile);
  } else {
    for (const url of ['https://hoodline.com/', 'https://www.eleconomista.es/'])
      for (const profile of profiles) await probe(url, profile);
  }
} finally { db.close(); }
