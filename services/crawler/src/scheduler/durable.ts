import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { sites } from '../../../../config/sites.js';
import { chromeSites } from '../../../../config/profiles.js';
import { domainFor, classify } from '../../../../packages/core/src/policy.js';
import { discover, parseArticle } from '../../../../packages/core/src/parse.js';
import { migrateDurable } from '../../../../packages/db/src/migrations/durable.js';
import { DISPATCH_MS, LEASE_MS, MAX_RESPONSE_BYTES, REQUEST_TIMEOUT_MS, type Assignment, type Completion, type Claim } from '../../../../packages/protocol/src/index.js';
import { reserveSlot } from './budget.js';
const robotsParser: typeof import('robots-parser').default = createRequire(import.meta.url)('robots-parser');
const UA = 'ExaTrialCrawler/0.1';
type Row = Record<string, any>;
export class ContractError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
export class Scheduler {
  constructor(readonly db: DatabaseSync, readonly directory: string, readonly clock = Date.now) { migrateDurable(db); }
  one(sql: string, ...params: any[]): Row | undefined { return this.db.prepare(sql).get(...params); }
  all(sql: string, ...params: any[]): Row[] { return this.db.prepare(sql).all(...params); }
  run(sql: string, ...params: any[]) { return this.db.prepare(sql).run(...params); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  recover() {
    const now = this.clock();
    this.transaction(() => {
      for (const a of this.all('SELECT * FROM attempt_assignments WHERE terminal IS NULL AND lease_until<=?', now)) {
        // Unknown attempts retain their charge and the entire safe timeout horizon.
        this.run("UPDATE requests SET finished=?,error='Lease expired; outcome unknown' WHERE id=?", now, a.request_id);
        this.run("UPDATE attempt_assignments SET terminal='expired',processing='done' WHERE attempt_id=?", a.attempt_id);
        this.fail(this.one('SELECT * FROM crawl_tasks WHERE id=?', a.task_id)!, 'Lease expired; outcome unknown');
      }
    });
    this.process();
  }
  claim(worker: string, claim: string): Claim {
    if (![worker,claim].every(x => typeof x === 'string' && /^[\w.-]{1,128}$/.test(x))) throw new ContractError('Invalid worker_id or claim_id');
    this.recover();
    return this.transaction(() => {
      const prior = this.one('SELECT * FROM attempt_assignments WHERE claim_id=?', claim);
      if (prior) {
        if (prior.worker_id !== worker) throw new ContractError('Claim belongs to another worker',409);
        return { task: JSON.parse(prior.assignment) };
      }
      const now = this.clock();
      for (const site of sites) {
        if (!this.one('SELECT 1 FROM sites WHERE domain=?',site.domain)) continue;
        if (this.one("SELECT 1 FROM attempt_assignments WHERE domain=? AND (terminal IS NULL OR processing='pending')", site.domain)) continue;
        const baseline = this.one("SELECT count(*) n FROM candidates WHERE domain=? AND priority=0 AND state<>'pending'", site.domain)!.n;
        const candidate = this.one(`SELECT t.* FROM crawl_tasks t JOIN candidates c ON c.url=t.url
          WHERE t.domain=? AND t.purpose='article' AND t.state='ready' AND t.next_crawl_at<=? AND c.state='pending'
          AND (c.priority>0 OR (c.priority=0 AND ?<8)) ORDER BY c.priority DESC,c.discovered DESC,c.rowid ASC LIMIT 1`, site.domain,now,baseline);
        const source = this.one(`SELECT t.* FROM crawl_tasks t JOIN sources s ON s.url=t.url
          WHERE t.domain=? AND t.purpose='discovery' AND t.state='ready' AND t.next_crawl_at<=?
          ORDER BY CASE WHEN s.polls=0 AND s.errors=0 THEN 0 ELSE 1 END,s.next_poll ASC LIMIT 1`,site.domain,now);
        const turns = this.one('SELECT articles_since_poll n FROM scheduler_domains WHERE domain=?',site.domain)!.n;
        let task = source && (turns>=2 || !candidate) ? source : candidate;
        // A robots chain must finish before its waiting parent can be dispatched.
        const robots = this.one("SELECT * FROM crawl_tasks WHERE domain=? AND purpose='robots' AND state='ready' AND next_crawl_at<=? ORDER BY id LIMIT 1",site.domain,now);
        if (robots) task = robots;
        if (!task) continue;
        const assignedDomain = domainFor(task.current_url);
        if (!assignedDomain) { this.fail(task,'URL is outside configured domains',true); continue; }
        if (this.one("SELECT 1 FROM attempt_assignments WHERE domain=? AND (terminal IS NULL OR processing='pending')",assignedDomain)) continue;
        let delay = 0;
        if (task.purpose !== 'robots') {
          const origin = new URL(task.current_url).origin;
          const cached = this.one('SELECT * FROM robots WHERE origin=?',origin);
          if (!cached || cached.expires < now) {
            const url = origin+'/robots.txt';
            this.run(`INSERT INTO crawl_tasks(domain,url,purpose,next_crawl_at,current_url,parent_id,origin)
              VALUES (?,?,'robots',?,?,?,?) ON CONFLICT(url,purpose) DO UPDATE SET state='ready',next_crawl_at=excluded.next_crawl_at,
              current_url=excluded.current_url,hops=0,parent_id=excluded.parent_id
              WHERE crawl_tasks.state='processed'`, assignedDomain,url,now,url,task.id,origin);
            task = this.one("SELECT * FROM crawl_tasks WHERE url=? AND purpose='robots'",url)!;
            if (task.state!=='ready' || task.next_crawl_at>now) continue;
          } else {
            const rules=robotsParser(origin+'/robots.txt',cached.body);
            if (rules.isAllowed(task.current_url,UA)===false) { this.fail(task,`robots.txt disallows ${task.current_url}`,true); continue; }
            delay=rules.getCrawlDelay(UA)||0;
          }
        }
        const domain=domainFor(task.current_url)!;
        const rpm=sites.find(s=>s.domain===domain)!.requestsPerMinute;
        const slot=reserveSlot(this.db,domain,task.current_url,task.purpose,rpm,delay,now);
        if (!slot.id) continue;
        const headers: Record<string,string> = task.hops ? {} : JSON.parse(task.headers);
        if (task.purpose==='discovery' && !task.hops) {
          const s=this.one('SELECT * FROM sources WHERE url=?',task.url)!;
          if(s.etag) headers['If-None-Match']=s.etag;
          if(s.modified) headers['If-Modified-Since']=s.modified;
        }
        const value: Assignment = { task_id:String(task.id),attempt_id:randomUUID(),lease_token:randomUUID(),domain,url:task.current_url,
          purpose:task.purpose,transport:chromeSites.has(domain)?'chrome136':'node',headers,timeout_ms:REQUEST_TIMEOUT_MS,max_response_bytes:MAX_RESPONSE_BYTES,
          start_by:new Date(now+DISPATCH_MS).toISOString(),lease_until:new Date(now+LEASE_MS).toISOString() };
        this.run(`INSERT INTO attempt_assignments(attempt_id,request_id,task_id,domain,worker_id,claim_id,lease_token,start_by,lease_until,assignment)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,value.attempt_id,slot.id,task.id,domain,worker,claim,value.lease_token,now+DISPATCH_MS,now+LEASE_MS,JSON.stringify(value));
        this.run("UPDATE crawl_tasks SET state='leased' WHERE id=?",task.id);
        return {task:value};
      }
      return {task:null,retry_after_ms:1000};
    });
  }
  complete(id: string, value: Completion) {
    return this.transaction(() => {
      const a=this.one('SELECT * FROM attempt_assignments WHERE attempt_id=?',id);
      if(!a) throw new ContractError('Unknown attempt',404);
      if(value.lease_token!==a.lease_token) throw new ContractError('Invalid lease token',403);
      if(a.terminal) return {outcome:a.terminal};
      if(this.clock()>=a.lease_until) throw new ContractError('Lease expired',409);
      if (!value || !Number.isFinite(Date.parse(value.finished_at)) || (value.started_at!==null && !Number.isFinite(Date.parse(value.started_at)))
        || (value.status!==null && (!Number.isInteger(value.status)||value.status<200||value.status>599))
        || !Number.isInteger(value.bytes)||value.bytes<0||value.bytes>MAX_RESPONSE_BYTES
        || (value.error!==null && (typeof value.error!=='string'||value.error.length>4096))
        || !value.headers || typeof value.headers!=='object' || Array.isArray(value.headers)
        || Object.entries(value.headers).some(([k,v])=>k.length>256||typeof v!=='string'||v.length>16384)) throw new ContractError('Invalid completion');
      if ((value.body_hash!==null && (typeof value.body_hash!=='string'||!/^[a-f0-9]{64}$/.test(value.body_hash)))
        || (value.response_ref!==null && value.response_ref!==`snapshots/${value.body_hash}.gz`)) throw new ContractError('Invalid archive reference');
      if (!value.finished_at.endsWith('Z') || (value.started_at!==null && !value.started_at.endsWith('Z'))) throw new ContractError('Timestamps must use UTC');
      if (!value.error && (value.status===null||!value.started_at||!value.body_hash||!/^[a-f0-9]{64}$/.test(value.body_hash)
        || value.response_ref!==`snapshots/${value.body_hash}.gz`)) throw new ContractError('Successful response requires archive');
      if(value.started_at && Date.parse(value.started_at)>a.start_by) throw new ContractError('Dispatch after deadline');
      const now=this.clock();
      this.run('UPDATE requests SET finished=?,status=?,headers=?,body_hash=?,error=? WHERE id=?',now,value.status,JSON.stringify(value.headers),value.body_hash,value.error,a.request_id);
      if ([429,503].includes(value.status!)) {
        const retry=value.headers['retry-after']||'300';
        const until=/^\d+$/.test(retry)?now+Number(retry)*1000:Date.parse(retry);
        this.run('UPDATE sites SET cooldown=max(cooldown,?) WHERE domain=?',Math.max(now+60_000,until||0),a.domain);
      }
      this.run("UPDATE attempt_assignments SET terminal='completed',completion=?,processing='pending' WHERE attempt_id=?",JSON.stringify(value),id);
      this.run("UPDATE crawl_tasks SET state='downloaded' WHERE id=?",a.task_id);
      return {outcome:'completed'};
    });
  }
  ensureTask(url: string, purpose: 'article' | 'discovery') {
    const item=this.one(`SELECT * FROM ${purpose==='article'?'candidates':'sources'} WHERE url=?`,url)!;
    this.run(`INSERT OR IGNORE INTO crawl_tasks(domain,url,purpose,priority,next_crawl_at,current_url) VALUES (?,?,?,?,?,?)`,item.domain,url,purpose,item.priority||0,purpose==='article'?item.next_attempt:item.next_poll,url);
    if(purpose==='article') this.run("UPDATE crawl_tasks SET priority=? WHERE url=? AND purpose='article' AND state='ready'",item.priority,url);
  }
  fail(task: Row, error: string, denied=false) {
    const now=this.clock();
    if(task.purpose==='robots') {
      this.run("UPDATE crawl_tasks SET state='processed' WHERE id=?",task.id);
      const parent=this.one('SELECT * FROM crawl_tasks WHERE id=?',task.parent_id);
      if(parent) this.fail(parent,error,denied);
      return;
    }
    if(task.purpose==='discovery') {
      const source=this.one('SELECT * FROM sources WHERE url=?',task.url)!;
      const due=now+(denied?3600_000:Math.min(3600_000,30_000*2**source.errors));
      this.run('UPDATE sources SET errors=errors+1,next_poll=?,last_error=? WHERE url=?',due,error,task.url);
      this.run("UPDATE crawl_tasks SET state='ready',next_crawl_at=?,current_url=url,hops=0 WHERE id=?",due,task.id);
      this.run('UPDATE scheduler_domains SET articles_since_poll=0 WHERE domain=?',task.domain);
    } else {
      const item=this.one('SELECT * FROM candidates WHERE url=?',task.url)!;
      const terminal=denied || /HTTP (404|410)/.test(error) || item.attempts>=2;
      const due=now+60_000*2**item.attempts;
      this.run('UPDATE candidates SET state=?,attempts=attempts+1,next_attempt=?,last_error=? WHERE url=?',terminal?'failed':'pending',due,error,task.url);
      this.run('UPDATE crawl_tasks SET state=?,next_crawl_at=?,current_url=url,hops=0 WHERE id=?',terminal?'processed':'ready',due,task.id);
      this.run('UPDATE scheduler_domains SET articles_since_poll=articles_since_poll+1 WHERE domain=?',task.domain);
    }
  }
  process() {
    for(const a of this.all("SELECT * FROM attempt_assignments WHERE processing='pending' AND process_after<=? ORDER BY request_id LIMIT 50",this.clock())) {
      try {
        const exports: {payload:string;fresh:boolean}[]=[];
        this.transaction(()=> {
          const task=this.one('SELECT * FROM crawl_tasks WHERE id=?',a.task_id)!;
          const value: Completion=JSON.parse(a.completion);
          if(value.error) this.fail(task,value.error);
          else {
            const bytes=gunzipSync(readFileSync(resolve(this.directory,value.response_ref!)),{maxOutputLength:MAX_RESPONSE_BYTES});
            if(bytes.length!==value.bytes||createHash('sha256').update(bytes).digest('hex')!==value.body_hash) throw new Error('Archive integrity mismatch');
            const charset=value.headers['content-type']?.match(/charset=["']?([^;"'\s]+)/i)?.[1]
              || bytes.subarray(0,2048).toString('ascii').match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] || 'utf-8';
            let body:string; try {body=new TextDecoder(charset).decode(bytes);} catch {body=bytes.toString('utf8');}
            this.apply(task,value,body,exports);
          }
          this.run("UPDATE attempt_assignments SET processing='done',process_error=NULL WHERE attempt_id=?",a.attempt_id);
            });
        // SQLite is authoritative. Preserve the existing best-effort JSONL exports.
        for(const item of exports) {
          try { appendFileSync(resolve(this.directory,'articles.jsonl'),item.payload+'\n');
            if(item.fresh) appendFileSync(resolve(this.directory,'new-articles.jsonl'),item.payload+'\n');
          } catch(e) {console.error('JSONL export failed',String(e));}
        }
      } catch(e) {
        this.run('UPDATE attempt_assignments SET process_errors=process_errors+1,process_error=?,process_after=? WHERE attempt_id=?',String(e),this.clock()+Math.min(3600_000,5000*2**Math.min(a.process_errors,10)),a.attempt_id);
      }
    }
  }
  apply(task: Row, value: Completion, body: string, exports: {payload:string;fresh:boolean}[]) {
    const now=this.clock(), status=value.status!;
    if(status>=300 && status<400 && status!==304 && value.headers.location) {
      if(task.hops>=5) {this.fail(task,'Too many redirects');return;}
      let next:string; try {next=new URL(value.headers.location,task.current_url).href;} catch {this.fail(task,'Invalid redirect');return;}
      if(!domainFor(next)) {this.fail(task,'URL is outside configured domains',true);return;}
      this.run("UPDATE crawl_tasks SET state='ready',current_url=?,hops=hops+1,next_crawl_at=? WHERE id=?",next,now,task.id);
      return;
    }
    if(task.purpose==='robots') {
      let ttl=6*3600_000;
      if([401,403].includes(status)) {body='User-agent: *\nDisallow: /';ttl=3600_000;}
      else if([404,410].includes(status)) body='';
      else if(status>=400) {this.fail(task,`robots.txt HTTP ${status}`);return;}
      else if(/<html[\s>]/i.test(body)) {this.fail(task,'robots.txt returned HTML');return;}
      this.run('INSERT OR REPLACE INTO robots(origin,body,expires) VALUES (?,?,?)',task.origin,body,now+ttl);
      for(const map of robotsParser(task.origin+'/robots.txt',body).getSitemaps().slice(0,6)) {
        if(domainFor(map)===task.domain) { this.run('INSERT OR IGNORE INTO sources(url,domain,kind) VALUES (?,?,?)',map,task.domain,'sitemap'); this.ensureTask(map,'discovery'); }
      }
      this.run("UPDATE crawl_tasks SET state='processed' WHERE id=?",task.id);return;
    }
    const site=sites.find(s=>s.domain===task.domain)!;
    const started=this.one('SELECT started FROM sites WHERE domain=?',site.domain)!.started;
    if(task.purpose==='discovery') {
      if(status!==200 && status!==304) {this.fail(task,`HTTP ${status}`);return;}
      const source=this.one('SELECT * FROM sources WHERE url=?',task.url)!;
      let count=0;
      if(status===200) {
        const found=discover(body,task.current_url,source.kind);
        for(const child of found.sources) {
          if(domainFor(child.url)!==site.domain||source.depth>=3) continue;
          if(this.one('SELECT count(*) n FROM sources WHERE domain=?',site.domain)!.n<18)
            { this.run('INSERT OR IGNORE INTO sources(url,domain,kind,depth) VALUES (?,?,?,?)',child.url,site.domain,child.kind,source.depth+1); this.ensureTask(child.url,'discovery'); }
        }
        for(const item of found.articles) {
          if(domainFor(item.url)!==site.domain) continue;
          const publication=item.published?Date.parse(item.published):null;
          const priority=publication!==null?(publication>=started?100:-10):source.polls>0?50:0;
          count+=Number(this.run(`INSERT OR IGNORE INTO candidates(url,domain,source,discovered,published_hint,priority) VALUES (?,?,?,?,?,?)`,item.url,site.domain,source.url,now,item.published,priority).changes);
          if(item.published) this.run("UPDATE candidates SET published_hint=coalesce(published_hint,?),priority=max(priority,?) WHERE url=? AND state='pending'",item.published,priority,item.url);
          this.ensureTask(item.url,'article');
        }
      }
      const interval=Math.max(30_000,Math.ceil(180_000/site.requestsPerMinute));
      const due=now+interval*(source.kind==='sitemap'?2:1);
      this.run('UPDATE sources SET polls=polls+1,errors=0,last_error=NULL,next_poll=?,discovered=discovered+?,etag=coalesce(?,etag),modified=coalesce(?,modified) WHERE url=?',due,count,value.headers.etag??null,value.headers['last-modified']??null,task.url);
      this.run("UPDATE crawl_tasks SET state='ready',current_url=url,hops=0,next_crawl_at=? WHERE id=?",due,task.id);
      this.run('UPDATE scheduler_domains SET articles_since_poll=0 WHERE domain=?',site.domain);
    } else {
      if(status!==200) {this.fail(task,`HTTP ${status}`);return;}
      const item=this.one('SELECT * FROM candidates WHERE url=?',task.url)!;
      const article=parseArticle(body,task.current_url,item.discovered,item.published_hint);
      const fingerprint=createHash('sha256').update(article.text).digest('hex');
      const duplicate=!!this.one('SELECT 1 FROM articles WHERE fingerprint=? AND canonical_url<>?',fingerprint,article.canonicalUrl);
      const classification=classify(article.publishedAt,started,item.discovered,duplicate,article.isArticle&&article.text.length>=200&&article.title.length>0);
      const payload=JSON.stringify({...article,classification,fetchedAt:new Date(now).toISOString(),sourceUrl:item.url,domain:site.domain});
      const saved=this.run('INSERT OR IGNORE INTO articles(canonical_url,domain,discovered,fetched,published,classification,fingerprint,payload) VALUES (?,?,?,?,?,?,?,?)',article.canonicalUrl,site.domain,item.discovered,now,article.publishedAt,classification,fingerprint,payload);
      if(saved.changes) exports.push({payload,fresh:classification==='new'});
      this.run("UPDATE candidates SET state='done',attempts=attempts+1,last_error=NULL WHERE url=?",task.url);
      this.run("UPDATE crawl_tasks SET state='processed' WHERE id=?",task.id);
      this.run('UPDATE scheduler_domains SET articles_since_poll=articles_since_poll+1 WHERE domain=?',site.domain);
    }
  }
}
