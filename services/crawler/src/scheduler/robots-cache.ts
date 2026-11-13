import { createRequire } from 'node:module';
import type { DatabaseSync } from '../../../../packages/pg/src/sync.js';

const parseRobots: typeof import('robots-parser').default = createRequire(import.meta.url)('robots-parser');
export const ROBOTS_TTL_MS = 6 * 3600_000;
export const ROBOTS_DENIED_TTL_MS = 3600_000;
type Record = { body: string; expires: number };
type Validators = { url: string; etag?: string; modified?: string };
type Policy = Record & { rules: ReturnType<typeof parseRobots> };

// SQLite survives restarts; the bounded in-memory layer avoids reparsing rules
// for every article. Origin includes scheme/host/port, never the parent domain.
export class RobotsCache {
  private parsed = new Map<string, Policy>();
  private read;
  private readValidators;
  private write;
  private writeValidators;
  private clearValidators;
  constructor(private db: DatabaseSync) {
    this.read=db.prepare('SELECT body,expires FROM robots WHERE origin=?');
    this.readValidators=db.prepare('SELECT value FROM meta WHERE key=?');
    this.write=db.prepare('INSERT OR REPLACE INTO robots(origin,body,expires) VALUES (?,?,?)');
    this.writeValidators=db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)');
    this.clearValidators=db.prepare('DELETE FROM meta WHERE key=?');
  }
  private key(origin: string) { return 'robots-cache:'+origin; }
  private validators(origin: string): Validators | undefined {
    const row=this.readValidators.get(this.key(origin));
    if(!row)return;
    try { return JSON.parse(String(row.value)); } catch { return; }
  }
  get(origin: string, now: number): Policy | undefined {
    // Recheck SQLite so expiry, rollback and a changed policy invalidate memory.
    const row=this.read.get(origin) as Record | undefined;
    if(!row || row.expires<=now) {this.parsed.delete(origin);return;}
    const cached=this.parsed.get(origin);
    if(cached && cached.body===row.body && cached.expires===row.expires)return cached;
    const policy={...row,rules:parseRobots(origin+'/robots.txt',row.body)};
    // Do not retain unusually large policies, though they are still evaluated.
    if(row.body.length<=256*1024) {
      if(this.parsed.size>=64)this.parsed.delete(this.parsed.keys().next().value!);
      this.parsed.set(origin,policy);
    }
    return policy;
  }
  headers(origin: string, url: string): { [name: string]: string } {
    if(!this.read.get(origin))return {};
    const validators=this.validators(origin),headers:{[name:string]:string}={};
    // Validators belong to the final response URL, not a redirecting URL.
    if(validators?.url!==url)return headers;
    if(typeof validators.etag==='string' && validators.etag)headers['If-None-Match']=validators.etag;
    if(typeof validators.modified==='string' && validators.modified)headers['If-Modified-Since']=validators.modified;
    return headers;
  }
  save(origin: string, url: string, body: string, now: number, ttl: number,
    headers: {[name:string]:string}, conditional=true): Policy {
    if(!this.db.isTransaction)throw new Error('Robots cache writes require a transaction');
    this.write.run(origin,body,now+ttl);
    if(conditional) this.writeValidators.run(this.key(origin),JSON.stringify({url,etag:headers.etag,modified:headers['last-modified']}));
    else this.clearValidators.run(this.key(origin));
    this.parsed.delete(origin);
    return this.get(origin,now)!;
  }
  renew(origin: string, url: string, now: number, headers: {[name:string]:string}): Policy | undefined {
    const row=this.read.get(origin) as Record | undefined;
    const previous=this.validators(origin);
    if(!row || previous?.url!==url || (!previous.etag && !previous.modified))return;
    return this.save(origin,url,row.body,now,ROBOTS_TTL_MS,{
      etag:headers.etag ?? previous.etag ?? '',
      'last-modified':headers['last-modified'] ?? previous.modified ?? '',
    });
  }
}
