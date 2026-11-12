import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { sites } from '../../../../config/sites.js';
import { chromeSites } from '../../../../config/profiles.js';
import { domainFor, classify } from '../../../../packages/core/src/policy.js';
import { discover, parseArticle, type Found } from '../../../../packages/core/src/parse.js';
import { migrateDurable } from '../../../../packages/db/src/migrations/durable.js';
import { DISPATCH_MS, LEASE_MS, MAX_RESPONSE_BYTES, REQUEST_TIMEOUT_MS, type Assignment, type Completion, type Claim } from '../../../../packages/protocol/src/index.js';
import { reserveSlot, slotDue } from './budget.js';
import { ArchiveParser, type ParseResult } from './parse-worker.js';
import { sourcePriority, urlRecencyPriority } from '../../../../config/discovery.js';
const robotsParser: typeof import('robots-parser').default = createRequire(import.meta.url)('robots-parser');
const UA = 'ExaTrialCrawler/0.1';
type Row = Record<string, any>;
export class ContractError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
export class Scheduler {
  private parser: ArchiveParser;
  private processingJob?: Promise<void>;
  private closing=false;
  private sourceQuality = new Map<string, { domain: string; polls: number; unchanged: number; newArticles: number }>();
  constructor(readonly db: DatabaseSync, readonly directory: string, readonly clock = Date.now) { migrateDurable(db); this.parser=new ArchiveParser(directory); this.refreshSourceQuality(); }
  // Once per minute, outside claim transactions. Count successfully parsed NEW
  // articles, not raw links. A canonical redirect can conservatively undercount.
  refreshSourceQuality() {
    const since=this.clock()-3600_000;
    this.sourceQuality=new Map(this.all('SELECT url,domain FROM sources').map(s=>[s.url,{domain:s.domain,polls:0,unchanged:0,newArticles:0}]));
    for(const row of this.all(`SELECT t.url,count(*) polls,sum(r.status=304) unchanged FROM requests r
      JOIN attempt_assignments a ON a.request_id=r.id JOIN crawl_tasks t ON t.id=a.task_id
      WHERE r.finished>=? AND r.status IN (200,304) AND r.error IS NULL AND a.processing='done' AND a.process_error IS NULL AND t.purpose='discovery' GROUP BY t.url`,since)) {
      const quality=this.sourceQuality.get(row.url); if(quality) Object.assign(quality,{polls:row.polls,unchanged:row.unchanged});
    }
    for(const row of this.all(`SELECT c.source,count(*) n FROM articles a JOIN candidates c ON c.url=a.canonical_url
      WHERE a.fetched>=? AND a.classification='new' GROUP BY c.source`,since)) {
      const quality=this.sourceQuality.get(row.source); if(quality) quality.newArticles=row.n;
    }
  }
  sourceScore(source: Row) {
    const q=this.sourceQuality.get(source.url);
    return sourcePriority(source.url,source.kind)+(q?Math.min(40,20*q.newArticles/Math.max(1,q.polls)):0);
  }
  sourceInterval(source: Row, base: number) {
    if(sourcePriority(source.url,source.kind)<0) return Math.max(base,6*3600_000);
    const q=this.sourceQuality.get(source.url);
    const alternative=[...this.sourceQuality.entries()].some(([url,other])=>url!==source.url && other.domain===source.domain && other.newArticles>0);
    // Quiet sites retain their normal cadence. Only proven unproductive sources
    // yield budget to productive alternatives on the same site.
    return q && q.polls>=3 && q.newArticles===0 && alternative ? Math.max(base,300_000) : base;
  }
  one(sql: string, ...params: any[]): Row | undefined { return this.db.prepare(sql).get(...params); }
  all(sql: string, ...params: any[]): Row[] { return this.db.prepare(sql).all(...params); }
  run(sql: string, ...params: any[]) { return this.db.prepare(sql).run(...params); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  recover(process = true) {
    const now = this.clock();
    this.transaction(() => {
      for (const a of this.all('SELECT * FROM attempt_assignments WHERE terminal IS NULL AND lease_until<=?', now)) {
        // Unknown attempts retain their charge and the entire safe timeout horizon.
        this.run("UPDATE requests SET finished=?,error='Lease expired; outcome unknown' WHERE id=?", now, a.request_id);
        this.run("UPDATE attempt_assignments SET terminal='expired',processing='done' WHERE attempt_id=?", a.attempt_id);
        this.fail(this.one('SELECT * FROM crawl_tasks WHERE id=?', a.task_id)!, 'Lease expired; outcome unknown');
      }
    });
    if (process) this.process(1);
  }
  claim(worker: string, claim: string): Claim {
    if (![worker,claim].every(x => typeof x === 'string' && /^[\w.-]{1,128}$/.test(x))) throw new ContractError('Invalid worker_id or claim_id');
    this.recover(false);
    return this.transaction(() => {
      const prior = this.one('SELECT * FROM attempt_assignments WHERE claim_id=?', claim);
      if (prior) {
        if (prior.worker_id !== worker) throw new ContractError('Claim belongs to another worker',409);
        return { task: JSON.parse(prior.assignment) };
      }
      const now = this.clock();
      for (const site of sites) {
        if (!this.one('SELECT 1 FROM sites WHERE domain=?',site.domain)) continue;
        if (this.one("SELECT 1 FROM attempt_assignments WHERE domain=? AND terminal IS NULL", site.domain)) continue;
        // Avoid scanning large candidate queues before this domain can spend a slot.
        if (slotDue(this.db, site.domain, site.requestsPerMinute, 0, now) > now) continue;
        const baseline = this.one("SELECT count(*) n FROM candidates WHERE domain=? AND priority=0 AND state<>'pending'", site.domain)!.n;
        const articleTurns=Number(this.one('SELECT value FROM meta WHERE key=?','article-turns:'+site.domain)?.value||0);
        const catchup=articleTurns%5===4;
        const order=catchup?'c.discovered ASC,c.rowid ASC':"CASE WHEN c.published_hint>=? THEN 2 WHEN c.published_hint IS NULL AND c.discovered>=? THEN 1 ELSE 0 END DESC,c.priority DESC,c.published_hint DESC,c.discovered DESC,c.rowid ASC";
        const orderParams=catchup?[]:[new Date(now-3600_000).toISOString(),now-3600_000];
        const candidate = this.one(`SELECT t.* FROM candidates c INDEXED BY candidate_queue CROSS JOIN crawl_tasks t ON t.url=c.url
          WHERE c.domain=? AND t.purpose='article' AND t.state='ready' AND t.next_crawl_at<=? AND c.state='pending'
          AND (c.priority>0 OR (c.priority=0 AND ?<8))
          AND NOT EXISTS(SELECT 1 FROM crawl_tasks r WHERE r.domain=c.domain AND r.purpose='robots' AND r.state='processed' AND r.next_crawl_at>? AND t.current_url LIKE r.origin||'/%') ORDER BY ${order} LIMIT 1`, site.domain,now,baseline,now,...orderParams);
        const source = this.all(`SELECT t.*,s.kind,s.polls,s.errors,s.next_poll FROM crawl_tasks t JOIN sources s ON s.url=t.url
          WHERE t.domain=? AND t.purpose='discovery' AND t.state='ready' AND t.next_crawl_at<=?
          AND NOT EXISTS(SELECT 1 FROM crawl_tasks r WHERE r.domain=t.domain AND r.purpose='robots' AND r.state='processed' AND r.next_crawl_at>? AND t.current_url LIKE r.origin||'/%')`,site.domain,now,now)
          .sort((a,b)=>this.sourceScore(b)-this.sourceScore(a)||a.next_poll-b.next_poll)[0];
        const turns = this.one('SELECT articles_since_poll n FROM scheduler_domains WHERE domain=?',site.domain)!.n;
        let task = source && (turns>=2 || !candidate) ? source : candidate;
        // Audits only use otherwise idle slots, at most one starting per domain/hour.
        if (!task) task = this.one(`SELECT * FROM crawl_tasks WHERE domain=? AND purpose='audit' AND state='ready' AND next_crawl_at<=?
          AND (hops>0 OR NOT EXISTS(SELECT 1 FROM requests WHERE domain=? AND purpose='audit' AND started>?)) ORDER BY id LIMIT 1`,site.domain,now,site.domain,now-3600_000);
        // A robots chain must finish before its waiting parent can be dispatched.
        const robots = this.one("SELECT * FROM crawl_tasks WHERE domain=? AND purpose='robots' AND state='ready' AND next_crawl_at<=? ORDER BY id LIMIT 1",site.domain,now);
        if (robots) task = robots;
        if (!task) continue;
        const assignedDomain = domainFor(task.current_url);
        if (!assignedDomain) { this.fail(task,'URL is outside configured domains',true); continue; }
        if (this.one("SELECT 1 FROM attempt_assignments WHERE domain=? AND terminal IS NULL",assignedDomain)) continue;
        let delay = 0;
        if (task.purpose !== 'robots') {
          const origin = new URL(task.current_url).origin;
          const cached = this.one('SELECT * FROM robots WHERE origin=?',origin);
          if (!cached || cached.expires < now) {
            const url = origin+'/robots.txt';
            this.run(`INSERT INTO crawl_tasks(domain,url,purpose,next_crawl_at,current_url,parent_id,origin)
              VALUES (?,?,'robots',?,?,?,?) ON CONFLICT(url,purpose) DO UPDATE SET state='ready',next_crawl_at=excluded.next_crawl_at,
              current_url=excluded.current_url,hops=0,parent_id=excluded.parent_id
              WHERE crawl_tasks.state='processed' AND crawl_tasks.next_crawl_at<=excluded.next_crawl_at`, assignedDomain,url,now,url,task.id,origin);
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
        if(task.purpose==='article') this.run('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)','article-turns:'+site.domain,String(articleTurns+1));
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
    if(task.purpose==='audit') {
      this.run("UPDATE crawl_tasks SET state='processed' WHERE id=?",task.id);
      return;
    }
    if(task.purpose==='robots') {
      // A broken robots endpoint must not consume the domain's entire budget.
      // Keep the origin unavailable for an hour, including after a restart.
      const due=now+3600_000;
      this.run("UPDATE crawl_tasks SET state='processed',next_crawl_at=?,current_url=url,hops=0 WHERE id=?",due,task.id);
      const parent=this.one('SELECT * FROM crawl_tasks WHERE id=?',task.parent_id);
      if(parent) {
        this.run('UPDATE crawl_tasks SET next_crawl_at=max(next_crawl_at,?) WHERE id=?',due,parent.id);
        if(parent.purpose==='discovery') this.run('UPDATE sources SET next_poll=max(next_poll,?),errors=errors+1,last_error=? WHERE url=?',due,error,parent.url);
        if(parent.purpose==='article') this.run('UPDATE candidates SET next_attempt=max(next_attempt,?),last_error=? WHERE url=?',due,error,parent.url);
      }
      return;
    }
    if(task.purpose==='discovery') {
      const source=this.one('SELECT * FROM sources WHERE url=?',task.url)!;
      if(/HTTP (404|410)/.test(error)) this.run('DELETE FROM meta WHERE key=?','source-final:'+task.url);
      const permanent=/Response exceeds 5 MiB|Not a supported feed or sitemap/.test(error);
      const due=now+(permanent?6*3600_000:denied?3600_000:Math.min(3600_000,30_000*2**source.errors));
      this.run('UPDATE sources SET errors=errors+1,next_poll=?,last_error=? WHERE url=?',due,error,task.url);
      this.run("UPDATE crawl_tasks SET state='ready',next_crawl_at=?,current_url=coalesce((SELECT value FROM meta WHERE key=?),url),hops=0 WHERE id=?",due,'source-final:'+task.url,task.id);
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
  private mapCandidate(item: Found, source: Row, domain: string, started: number, observed: number, now: number) {
    if(domainFor(item.url)!==domain) return 0;
    const publication=item.published?Date.parse(item.published):null;
    const priority=publication!==null?(publication>=started?100:-10):source.polls>0?urlRecencyPriority(item.url,now):0;
    const count=Number(this.run(`INSERT OR IGNORE INTO candidates(url,domain,source,discovered,published_hint,priority) VALUES (?,?,?,?,?,?)`,item.url,domain,source.url,observed,item.published,priority).changes);
    // Repeated homepage sightings retain their original discovery timestamp.
    if(item.published || (source.kind==='html' && priority>0)) this.run("UPDATE candidates SET published_hint=coalesce(published_hint,?),priority=max(priority,?),discovered=min(discovered,?) WHERE url=? AND state='pending'",item.published,priority,observed,item.url);
    this.ensureTask(item.url,'article');
    return count;
  }
  private async mapDiscoveryChunks(task: Row, value: Completion, found: ReturnType<typeof discover>) {
    const source=this.one('SELECT * FROM sources WHERE url=?',task.url)!;
    const started=this.one('SELECT started FROM sites WHERE domain=?',task.domain)!.started;
    const observed=Date.parse(value.finished_at);
    for(let offset=0;offset<found.articles.length;offset+=100) {
      if(this.closing) return false;
      this.transaction(()=> {
        let count=0;
        for(const item of found.articles.slice(offset,offset+100)) count+=this.mapCandidate(item,source,task.domain,started,observed,this.clock());
        this.run('UPDATE sources SET discovered=discovered+? WHERE url=?',count,task.url);
      });
      // Release both SQLite's write lock and the main event loop between chunks.
      // A crash can replay the archive: INSERT OR IGNORE only counts new rows.
      await new Promise<void>(done=>setImmediate(done));
    }
    return true;
  }
  private readBody(value: Completion) {
    const bytes=gunzipSync(readFileSync(resolve(this.directory,value.response_ref!)),{maxOutputLength:MAX_RESPONSE_BYTES});
    if(bytes.length!==value.bytes||createHash('sha256').update(bytes).digest('hex')!==value.body_hash) throw new Error('Archive integrity mismatch');
    const charset=value.headers['content-type']?.match(/charset=["']?([^;"'\s]+)/i)?.[1]
      || bytes.subarray(0,2048).toString('ascii').match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] || 'utf-8';
    try { return new TextDecoder(charset).decode(bytes); } catch { return bytes.toString('utf8'); }
  }
  private finishProcessing(a: Row, task: Row, value: Completion, body: string, parsed?: ParseResult) {
    const exports: {payload:string;fresh:boolean}[]=[];
    this.transaction(()=> {
      if(this.one('SELECT processing FROM attempt_assignments WHERE attempt_id=?',a.attempt_id)?.processing!=='pending') return;
      if(value.error) this.fail(task,value.error);
      else this.apply(task,value,body,exports,parsed);
      this.run("UPDATE attempt_assignments SET processing='done',process_error=NULL WHERE attempt_id=?",a.attempt_id);
    });
    for(const item of exports) {
      try { appendFileSync(resolve(this.directory,'articles.jsonl'),item.payload+'\n');
        if(item.fresh) appendFileSync(resolve(this.directory,'new-articles.jsonl'),item.payload+'\n');
      } catch(e) {console.error('JSONL export failed',String(e));}
    }
  }
  private processingFailure(a: Row, error: unknown) {
    const message=String(error), task=this.one('SELECT * FROM crawl_tasks WHERE id=?',a.task_id)!;
    if(task.purpose==='discovery' && /Response exceeds 5 MiB|Not a supported feed or sitemap/.test(message)) {
      this.transaction(()=> {
        this.fail(task,message);
        this.run("UPDATE attempt_assignments SET processing='done',process_errors=process_errors+1,process_error=? WHERE attempt_id=?",message,a.attempt_id);
      });
    } else this.run('UPDATE attempt_assignments SET process_errors=process_errors+1,process_error=?,process_after=? WHERE attempt_id=?',message,this.clock()+Math.min(3600_000,5000*2**Math.min(a.process_errors,10)),a.attempt_id);
  }
  // Synchronous fixture/recovery helper. Live entry points use processAsync.
  process(limit = 50) {
    if(this.processingJob) return;
    for(const a of this.all("SELECT * FROM attempt_assignments WHERE processing='pending' AND process_after<=? ORDER BY request_id LIMIT ?",this.clock(),limit)) {
      try {
        const task=this.one('SELECT * FROM crawl_tasks WHERE id=?',a.task_id)!,value: Completion=JSON.parse(a.completion);
        const body=value.error?'':this.readBody(value);
        let parsed: ParseResult|undefined;
        if(!value.error && value.status===200 && task.purpose==='discovery') parsed={kind:'discovery',found:discover(body,task.current_url,this.one('SELECT kind FROM sources WHERE url=?',task.url)!.kind)};
        if(!value.error && value.status===200 && task.purpose==='article') {
          const item=this.one('SELECT discovered,published_hint FROM candidates WHERE url=?',task.url)!;
          parsed={kind:'article',article:parseArticle(body,task.current_url,item.discovered,item.published_hint)};
        }
        this.finishProcessing(a,task,value,body,parsed);
      } catch(error) {this.processingFailure(a,error);}
    }
  }
  processAsync(): Promise<void> {
    if(this.closing) return Promise.resolve();
    if(this.processingJob) return this.processingJob;
    const a=this.one("SELECT * FROM attempt_assignments WHERE processing='pending' AND process_after<=? ORDER BY request_id LIMIT 1",this.clock());
    if(!a) return Promise.resolve();
    this.processingJob=(async()=> {
      try {
        const task=this.one('SELECT * FROM crawl_tasks WHERE id=?',a.task_id)!,value: Completion=JSON.parse(a.completion);
        let body='',parsed: ParseResult|undefined;
        if(!value.error && value.status===200 && ['article','discovery'].includes(task.purpose)) {
          const common={response_ref:value.response_ref!,body_hash:value.body_hash!,bytes:value.bytes,headers:value.headers,url:task.current_url};
          if(task.purpose==='discovery') parsed=await this.parser.parse({...common,kind:'discovery',sourceKind:this.one('SELECT kind FROM sources WHERE url=?',task.url)!.kind});
          else {
            const item=this.one('SELECT discovered,published_hint FROM candidates WHERE url=?',task.url)!;
            parsed=await this.parser.parse({...common,kind:'article',discovered:item.discovered,hint:item.published_hint});
          }
        } else if(!value.error) body=this.readBody(value);
        if(parsed?.kind==='discovery') {
          if(!await this.mapDiscoveryChunks(task,value,parsed.found)) return;
          parsed={kind:'discovery',found:{...parsed.found,articles:[]}};
        }
        // Parsing and decompression above happen without holding a write lock.
        this.finishProcessing(a,task,value,body,parsed);
      } catch(error) {this.processingFailure(a,error);}
    })().finally(()=> {this.processingJob=undefined;if(!this.closing) setImmediate(()=>void this.processAsync().catch(error=>console.error('archive processing failed',error)));});
    return this.processingJob;
  }
  async close() {
    this.closing=true;
    await this.processingJob;
    await this.parser.close();
  }
  apply(task: Row, value: Completion, body: string, exports: {payload:string;fresh:boolean}[], parsed?: ParseResult) {
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
      const auditParent=task.parent_id && this.one('SELECT purpose FROM crawl_tasks WHERE id=?',task.parent_id)?.purpose==='audit';
      // Robots fetched only for an external audit must not seed crawler discovery.
      for(const map of auditParent?[]:robotsParser(task.origin+'/robots.txt',body).getSitemaps()
        .filter(url=>domainFor(url)===task.domain && sourcePriority(url,'sitemap')>=0)
        .sort((a,b)=>sourcePriority(b,'sitemap')-sourcePriority(a,'sitemap')).slice(0,6)) {
        if(domainFor(map)===task.domain) { this.run('INSERT OR IGNORE INTO sources(url,domain,kind) VALUES (?,?,?)',map,task.domain,'sitemap'); this.ensureTask(map,'discovery'); }
      }
      this.run("UPDATE crawl_tasks SET state='processed' WHERE id=?",task.id);return;
    }
    // Audit responses are archived and visible in the request log, never discoveries.
    if(task.purpose==='audit') {
      this.run("UPDATE crawl_tasks SET state='processed' WHERE id=?",task.id);
      return;
    }
    const site=sites.find(s=>s.domain===task.domain)!;
    const started=this.one('SELECT started FROM sites WHERE domain=?',site.domain)!.started;
    if(task.purpose==='discovery') {
      if(status!==200 && status!==304) {this.fail(task,`HTTP ${status}`);return;}
      const source=this.one('SELECT * FROM sources WHERE url=?',task.url)!;
      const observed=Date.parse(value.finished_at);
      let count=0, partial=false;
      if(status===200) {
        const found=parsed?.kind==='discovery'?parsed.found:discover(body,task.current_url,source.kind);
        partial=found.partial;
        for(const child of found.sources) {
          if(domainFor(child.url)!==site.domain||source.depth>=3 || sourcePriority(child.url,child.kind)<0) continue;
          if(this.all('SELECT url,kind FROM sources WHERE domain=?',site.domain).filter(s=>sourcePriority(s.url,s.kind)>=0).length<18)
            { this.run('INSERT OR IGNORE INTO sources(url,domain,kind,depth) VALUES (?,?,?,?)',child.url,site.domain,child.kind,source.depth+1); this.ensureTask(child.url,'discovery'); }
        }
        for(const item of found.articles) count+=this.mapCandidate(item,source,site.domain,started,observed,now);
      }
      const interval=Math.max(30_000,Math.ceil(180_000/site.requestsPerMinute));
      const due=Math.max(now,observed+this.sourceInterval(source,interval*(source.kind==='sitemap'?2:1)));
      // Do not cache a partial response: next poll must request the complete body.
      this.run('UPDATE sources SET polls=polls+1,errors=?,last_error=?,next_poll=?,discovered=discovered+?,etag=?,modified=? WHERE url=?',partial?source.errors+1:0,partial?'Partial RSS: only complete items processed':null,due,count,partial?null:(value.headers.etag??source.etag),partial?null:(value.headers['last-modified']??source.modified),task.url);
      this.run('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)','source-final:'+task.url,task.current_url);
      this.run("UPDATE crawl_tasks SET state='ready',hops=0,next_crawl_at=? WHERE id=?",due,task.id);
      this.run('UPDATE scheduler_domains SET articles_since_poll=0 WHERE domain=?',site.domain);
    } else {
      if(status!==200) {this.fail(task,`HTTP ${status}`);return;}
      const item=this.one('SELECT * FROM candidates WHERE url=?',task.url)!;
      const article=parsed?.kind==='article'?parsed.article:parseArticle(body,task.current_url,item.discovered,item.published_hint);
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
