import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { db, get, run, dataDir } from '../packages/db/src/store.js';
import { domainFor } from '../packages/core/src/policy.js';
import { sites } from '../config/sites.js';
import { reserveSlot } from './budget.js';
import { fetchResponse, USER_AGENT } from './transport.js';

const robotsParser: typeof import('robots-parser').default = createRequire(import.meta.url)('robots-parser');

export const controller = new AbortController();
export const signal = controller.signal;
export { USER_AGENT } from './transport.js';
export const pause = (ms: number) => sleep(ms, undefined, { signal });
export class Denied extends Error {}
type ResponseData = { url: string; status: number; body: string; headers: Headers };
mkdirSync(resolve(dataDir, 'snapshots'), { recursive: true });

async function reserve(url: string, purpose: string, crawlDelay: number): Promise<number> {
  const domain = domainFor(url);
  if (!domain) throw new Denied(`Outside configured domains: ${url}`);
  const rpm = sites.find(s => s.domain === domain)!.requestsPerMinute;
  while (!signal.aborted) {
    const slot = reserveSlot(db, domain, url, purpose, rpm, crawlDelay);
    if (slot.id !== undefined) return slot.id;
    await pause(Math.max(1, slot.due - Date.now()));
  }
  throw new Error('Stopped');
}

async function raw(url: string, purpose: string, headers: Record<string, string> = {}, delay = 0): Promise<ResponseData> {
  const id = await reserve(url, purpose, delay);
  try {
    const response = await fetchResponse(url, headers, signal);
    run('UPDATE requests SET status=?,headers=? WHERE id=?', response.status, JSON.stringify(Object.fromEntries(response.headers)), id);
    const chunks: Uint8Array[] = [];
    let length = 0;
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 5 * 1024 * 1024) { await reader.cancel(); throw new Error('Response exceeds 5 MiB'); }
        chunks.push(value);
      }
    }
    let bytes = Buffer.concat(chunks);
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes, { maxOutputLength: 5 * 1024 * 1024 });
    const hash = createHash('sha256').update(bytes).digest('hex');
    const path = resolve(dataDir, 'snapshots', `${hash}.gz`);
    if (bytes.length && !existsSync(path)) writeFileSync(path, gzipSync(bytes));
    const charset = response.headers.get('content-type')?.match(/charset=["']?([^;"'\s]+)/i)?.[1]
      || bytes.subarray(0, 2048).toString('ascii').match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] || 'utf-8';
    let body: string;
    try { body = new TextDecoder(charset).decode(bytes); } catch { body = bytes.toString('utf8'); }
    run('UPDATE requests SET finished=?,body_hash=? WHERE id=?', Date.now(), hash, id);
    if ([429, 503].includes(response.status)) {
      const retry = response.headers.get('retry-after') || '300';
      const until = /^\d+$/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry);
      run('UPDATE sites SET cooldown=max(cooldown,?) WHERE domain=?', Math.max(Date.now() + 60_000, until || 0), domainFor(url)!);
    }
    return { url, status: response.status, body, headers: response.headers };
  } catch (e) {
    run('UPDATE requests SET finished=?,error=? WHERE id=?', Date.now(), String(e), id);
    throw e;
  }
}

async function policy(url: string) {
  const origin = new URL(url).origin;
  let cached = get<{ body: string; expires: number }>('SELECT * FROM robots WHERE origin=?', origin);
  if (!cached || cached.expires < Date.now()) {
    let current = `${origin}/robots.txt`;
    let response: ResponseData | undefined;
    for (let hop = 0; hop < 6; hop++) {
      response = await raw(current, 'robots');
      if (response.status < 300 || response.status >= 400 || !response.headers.get('location')) break;
      current = new URL(response.headers.get('location')!, current).href;
      if (!domainFor(current)) throw new Denied('robots.txt redirects outside configured domains');
      if (hop === 5) throw new Error('Too many robots.txt redirects');
    }
    if (!response) throw new Error('robots.txt unavailable');
    let body = response.body;
    let ttl = 6 * 3600_000;
    if ([401, 403].includes(response.status)) { body = 'User-agent: *\nDisallow: /'; ttl = 3600_000; }
    else if ([404, 410].includes(response.status)) body = '';
    else if (response.status >= 400) throw new Error(`robots.txt HTTP ${response.status}`);
    else if (/<html[\s>]/i.test(body)) throw new Error('robots.txt returned HTML');
    cached = { body, expires: Date.now() + ttl };
    run('INSERT OR REPLACE INTO robots(origin,body,expires) VALUES (?,?,?)', origin, body, cached.expires);
    const p = robotsParser(`${origin}/robots.txt`, body);
    const domain = domainFor(url)!;
    for (const map of p.getSitemaps().slice(0, 6)) {
      if (domainFor(map) === domain) run('INSERT OR IGNORE INTO sources(url,domain,kind) VALUES (?,?,?)', map, domain, 'sitemap');
    }
  }
  return robotsParser(`${origin}/robots.txt`, cached.body);
}

export async function request(url: string, purpose: string, headers: Record<string, string> = {}): Promise<ResponseData> {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    if (!domainFor(current)) throw new Denied('URL is outside configured domains');
    const rules = await policy(current);
    if (rules.isAllowed(current, USER_AGENT) === false) throw new Denied(`robots.txt disallows ${current}`);
    const response = await raw(current, purpose, headers, rules.getCrawlDelay(USER_AGENT) || 0);
    if (response.status >= 300 && response.status < 400 && response.status !== 304 && response.headers.get('location')) {
      current = new URL(response.headers.get('location')!, current).href;
      headers = {};
      continue;
    }
    return response;
  }
  throw new Error('Too many redirects');
}
