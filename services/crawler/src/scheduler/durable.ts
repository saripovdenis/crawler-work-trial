import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DatabaseSync } from '../../../../packages/pg/src/sync.js';
import { policy, configuredSource, defaultScheduling, fetchProfileFor } from '../../../../config/site-policy.js';
import { domainFor, classify, isKnownListingUrl } from '../../../../packages/core/src/policy.js';
import { discover, parseArticle, type Found } from '../../../../packages/core/src/parse.js';
import { migrateDurable } from '../../../../packages/db/src/migrations/durable.js';
import { DISPATCH_MS, LEASE_MS, MAX_RESPONSE_BYTES, REQUEST_TIMEOUT_MS, fetchFinishedAt, type Assignment, type Completion, type Claim } from '../../../../packages/protocol/src/index.js';
import { reserveSlot, slotDue, completeSlot } from './budget.js';
import { ArchiveParser, type ParseResult } from './parse-worker.js';
import { sourcePriority, urlRecencyPriority } from '../../../../config/discovery.js';
import { RobotsCache, ROBOTS_TTL_MS, ROBOTS_DENIED_TTL_MS } from './robots-cache.js';
import { PARSER_VERSION } from '../../../../packages/core/src/parser-version.js';
import { ArticleAliases } from '../../../../packages/db/src/aliases.js';
import { createBodyStore, type BodyStore } from '../../../../packages/protocol/src/body-store.js';
import { elapsedMs, timingEnabled, timingLog } from '../../../../packages/protocol/src/timing.js';
import { nextTurn } from './selection.js';
const UA = 'ExaTrialCrawler/0.1';
const STALE_LINK_MS = 3 * 3600_000;
const FRESH_SCORE_WINDOW_MS = 6 * 3600_000;
const FRESH_SOURCE_MIN_POLLS = 12;   // successful polls in the last hour: at least one per five minutes
const FRESH_SOURCE_MIN_DATED = 20;
const FRESH_SOURCE_MIN_SHARE = 0.7;
const FRESH_LINK_MS = 10 * 60_000;
const MAPPING_VERSION=createHash('sha256').update(PARSER_VERSION).update(readFileSync(new URL('./durable.ts',import.meta.url))).digest('hex');
type Row = Record<string, any>;
export class ContractError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
export class Scheduler {
  private parser: ArchiveParser;
  private robotsCache: RobotsCache;
  private aliases:ArticleAliases;
  private archives:BodyStore;
  private processingJob?: Promise<void>;
  private articlesSinceDiscovery = 3;
  private articleParses = 0;
  private closing=false;
  private metricsStartedAt=Date.now();
  private lastBacklog?:{at:number;count:number};
  private reuse={mappingSkips:0,avoidedDownloads:0,pendingArchiveWaits:0,archivedReparses:0,aliasesRecorded:0};
  private freshTurns = 0;
  private statements = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  private readonly domains = policy.all().map(site => site.domain);
  private readonly domainParams = this.domains.map(() => '?').join(',') || 'NULL';
  private sourceQuality = new Map<string, { domain: string; polls: number; unchanged: number; newArticles: number; dated: number; fresh: number }>();
  constructor(readonly db: DatabaseSync, readonly directory: string, readonly clock = Date.now) {
    migrateDurable(db); this.resetSeedRedirects(); this.parser=new ArchiveParser(directory); this.robotsCache=new RobotsCache(db);
    this.archives=createBodyStore(directory);this.aliases=new ArticleAliases(db);
    this.reuse.aliasesRecorded=this.aliases.backfill();this.refreshSourceQuality();
  }
  private resetSeedRedirects() {
    this.transaction(()=> {
      for(const site of policy.all()) for(const seed of site.seeds ?? []) {
        this.run('DELETE FROM meta WHERE key=?','source-final:'+seed.url);
        // Only completed poll cycles can be reset. Leases, pending parsing and
        // redirect hops must retain the URL of the response they belong to.
        const changed=this.run(`UPDATE crawl_tasks SET current_url=url,headers='{}'
          WHERE url=? AND purpose='discovery' AND state='ready' AND hops=0 AND current_url<>url`,seed.url).changes;
        if(changed) this.run('UPDATE sources SET etag=NULL,modified=NULL WHERE url=?',seed.url);
      }
    });
  }
  // A link that has waited this long since it was first seen can no longer be
  // a fresh article. Retire it as 'stale' without spending a request; the row
  // stays, so the same link is not queued again when a page keeps showing it.
  // Only waiting links are touched: leased or downloaded tasks finish normally.
  expireStale(limit = 5000): number {
    const active = policy.active().map(site => site.domain);
    if (!active.length) return 0;
    return this.transaction(() => {
      const rows=this.all(`SELECT c.url,t.id FROM candidates c
        JOIN crawl_tasks t ON t.url=c.url AND t.purpose='article'
        WHERE c.state='pending' AND c.priority>0 AND c.discovered<? AND t.state='ready'
        AND c.domain IN (${active.map(() => '?').join(',')}) LIMIT ?`,this.clock()-STALE_LINK_MS,...active,limit);
      for(const row of rows) {
        this.run("UPDATE candidates SET state='stale',last_error='Not fetched within 3 hours of discovery' WHERE url=?",row.url);
        this.run("UPDATE crawl_tasks SET state='processed' WHERE id=?",row.id);
      }
      return rows.length;
    });
  }
  // Once per minute, outside claim transactions. Count successfully parsed NEW
  // articles, not raw links. A canonical redirect can conservatively undercount.
  refreshSourceQuality() {
    const since=this.clock()-3600_000;
    this.sourceQuality=new Map(this.all('SELECT url,domain FROM sources').map(s=>[s.url,{domain:s.domain,polls:0,unchanged:0,newArticles:0,dated:0,fresh:0}]));
    for(const row of this.all(`SELECT t.url,count(*) polls,sum(r.status=304) unchanged FROM requests r
      JOIN attempt_assignments a ON a.request_id=r.id JOIN crawl_tasks t ON t.id=a.task_id
      WHERE r.finished>=? AND r.status IN (200,304) AND r.error IS NULL AND a.processing='done' AND a.process_error IS NULL AND t.purpose='discovery' GROUP BY t.url`,since)) {
      const quality=this.sourceQuality.get(row.url); if(quality) Object.assign(quality,{polls:row.polls,unchanged:row.unchanged});
    }
    for(const row of this.all(`SELECT c.source,count(*) n FROM articles a JOIN candidates c ON c.url=a.canonical_url
      WHERE a.fetched>=? AND a.classification='new' GROUP BY c.source`,since)) {
      const quality=this.sourceQuality.get(row.source); if(quality) quality.newArticles=row.n;
    }
    // Per page: of its links fetched in the last six hours that carry a date,
    // how many were under an hour old when the link was first seen there.
    for(const row of this.all(`SELECT c.source,count(*) dated,sum(c.discovered-unixepoch(a.published)*1000<3600000) fresh
      FROM articles a JOIN candidates c ON c.url=a.canonical_url
      WHERE a.fetched>=? AND a.published IS NOT NULL GROUP BY c.source`,this.clock()-FRESH_SCORE_WINDOW_MS)) {
      const quality=this.sourceQuality.get(row.source); if(quality) Object.assign(quality,{dated:row.dated,fresh:row.fresh});
    }
  }
  // Pages polled often enough, and proven fresh often enough, that "first seen
  // a few minutes ago" is good evidence the article itself is new.
  freshSources(domain?: string) {
    return [...this.sourceQuality.entries()].filter(([,q])=>(!domain || q.domain===domain)
      && q.polls>=FRESH_SOURCE_MIN_POLLS && q.dated>=FRESH_SOURCE_MIN_DATED && q.fresh>=q.dated*FRESH_SOURCE_MIN_SHARE)
      .map(([url,q])=>({url,domain:q.domain,pollsLastHour:q.polls,dated:q.dated,fresh:q.fresh}));
  }
  sourceInterval(source: Row, base: number) {
    const seed = configuredSource(source.url);
    if(seed) return seed.pollEveryMs ?? base;
    if(sourcePriority(source.url,source.kind)<0) return Math.max(base,6*3600_000);
    const q=this.sourceQuality.get(source.url);
    // Keep productive discovered sources fast; give the rest a 20-minute floor.
    return q && q.newArticles>0 ? base : Math.max(base,20*60_000);
  }
  private statement(sql: string) {
    let statement=this.statements.get(sql);
    if(!statement) {statement=this.db.prepare(sql);this.statements.set(sql,statement);}
    return statement;
  }
  cacheMetrics() {
    const now=this.clock();
    const backlog=this.all("SELECT t.purpose,count(*) count,min(r.finished) oldest FROM attempt_assignments a JOIN crawl_tasks t ON t.id=a.task_id JOIN requests r ON r.id=a.request_id WHERE a.processing='pending' GROUP BY t.purpose");
    const total=backlog.reduce((sum,row)=>sum+Number(row.count),0),previous=this.lastBacklog;
    this.lastBacklog={at:now,count:total};
    return {generatedAt:now,since:this.metricsStartedAt,parserVersion:PARSER_VERSION,mappingVersion:MAPPING_VERSION,extraction:this.parser.metrics,...this.reuse,
      freshTurns:this.freshTurns,freshSources:this.freshSources(),backlog,backlogTotal:total,backlogChange:previous?total-previous.count:null,
      backlogGrowthPerMinute:previous && now>previous.at?(total-previous.count)*60000/(now-previous.at):null,
      requestsLastMinute:this.one('SELECT count(*) count FROM requests WHERE started>=?',now-60_000)!.count};
  }
  private timedQuery<T>(sql:string,query:()=>T):T {
    if(!timingEnabled)return query();
    const started=performance.now();
    try {return query();}
    finally {
      const duration_ms=elapsedMs(started);
      if(duration_ms>=100)timingLog('slow_sql',{duration_ms,sql:sql.replace(/\s+/g,' ').slice(0,500)});
    }
  }
  one(sql: string, ...params: any[]): Row | undefined { return this.timedQuery(sql,()=>this.statement(sql).get(...params)); }
  all(sql: string, ...params: any[]): Row[] { return this.timedQuery(sql,()=>this.statement(sql).all(...params)); }
  run(sql: string, ...params: any[]) { return this.timedQuery(sql,()=>this.statement(sql).run(...params)); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  recover(process = true) {
    const now = this.clock();
    this.transaction(() => {
      for (const a of this.all('SELECT * FROM attempt_assignments WHERE terminal IS NULL AND lease_until<=? FOR UPDATE', now)) {
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
        const owner = this.one('SELECT domain FROM crawl_tasks WHERE id=?', prior.task_id);
        if (!policy.for(prior.domain)?.enabled || !policy.for(owner?.domain)?.enabled)
          return {task:null,retry_after_ms:1000};
        return { task: JSON.parse(prior.assignment) };
      }
      const now = this.clock();
      const eligible = this.all('SELECT domain FROM sites WHERE next_available_at<=? ORDER BY next_available_at,domain',now);
      for (const {domain: eligibleDomain} of eligible) {
        const site=policy.for(eligibleDomain);
        if (!site?.enabled) continue;
        if (!this.one('SELECT 1 FROM sites WHERE domain=?',site.domain)) continue;
        if (this.one("SELECT 1 FROM attempt_assignments WHERE domain=? AND terminal IS NULL", site.domain)) continue;
        // Avoid scanning large candidate queues before this domain can spend a slot.
        if (slotDue(this.db, site.domain, now) > now) continue;
        const baseline = this.one("SELECT count(*) n FROM (SELECT 1 FROM candidates WHERE domain=? AND priority=0 AND state<>'pending' LIMIT 8) settled", site.domain)!.n;
        // Choose the constant range before preparing SQL. The equivalent OR
        // predicate scans priority-zero rows even after the initial sample ends.
        const candidatePriority=baseline<8?'c.priority>=0':'c.priority>0';
        const articleTurns=Number(this.one('SELECT value FROM meta WHERE key=?','article-turns:'+site.domain)?.value||0);
        const catchup=articleTurns%5===4;
        const order="CASE WHEN c.published_hint>=? THEN 2 WHEN c.published_hint IS NULL AND c.discovered>=? THEN 1 ELSE 0 END DESC,c.priority DESC,c.published_hint DESC NULLS LAST,c.discovered DESC,c.rowid ASC";
        const pick=(extra:string,orderBy:string,params:(string|number)[])=>this.one(`SELECT t.* FROM candidates c INDEXED BY candidate_queue CROSS JOIN crawl_tasks t ON t.url=c.url
          WHERE c.domain=? AND t.purpose='article' AND t.state='ready' AND t.next_crawl_at<=? AND c.state='pending'
          AND ${candidatePriority}${extra}
          AND NOT EXISTS(SELECT 1 FROM crawl_tasks r WHERE r.domain=c.domain AND r.purpose='robots' AND (r.state='downloaded' OR (r.state='processed' AND r.next_crawl_at>?)) AND t.current_url LIKE r.origin||'/%') ORDER BY ${orderBy} LIMIT 1`, site.domain,now,...params);
        let candidate: Row | undefined;
        if(catchup) {
          // The fifth turn serves what the other four skip: the newest link with
          // no date signal of its own, first seen minutes ago on a proven page.
          const pages=this.freshSources(site.domain).map(s=>s.url);
          if(pages.length) candidate=pick(` AND c.priority<75 AND c.discovered>=? AND c.source IN (${pages.map(()=>'?').join(',')})`,
            'c.discovered DESC,c.rowid ASC',[now-FRESH_LINK_MS,...pages,now]);
          if(candidate) this.freshTurns++;
          else candidate=pick('','c.discovered ASC,c.rowid ASC',[now]);
        } else candidate=pick('',order,[now,new Date(now-3600_000).toISOString(),now-3600_000]);
        if(candidate && isKnownListingUrl(candidate.url)) {
          // Retire pre-existing navigation candidates without spending a request.
          this.run("UPDATE candidates SET state='failed',last_error='Known listing route, not an article' WHERE url=?",candidate.url);
          this.run("UPDATE crawl_tasks SET state='processed' WHERE id=?",candidate.id);
          continue;
        }
        if(candidate && this.reuseArticle(candidate,now))continue;
        const sourceCursorKey='discovery-cursor:'+site.domain;
        const savedCursor=Number(this.one('SELECT value FROM meta WHERE key=?',sourceCursorKey)?.value||0);
        const sourceCursor=Number.isSafeInteger(savedCursor) && savedCursor>=0 ? savedCursor : 0;
        const dueSources = `SELECT t.* FROM crawl_tasks t JOIN sources s ON s.url=t.url
          WHERE t.domain=? AND t.purpose='discovery' AND t.state='ready' AND t.next_crawl_at<=?
          AND NOT EXISTS(SELECT 1 FROM crawl_tasks r WHERE r.domain=t.domain AND r.purpose='robots' AND (r.state='downloaded' OR (r.state='processed' AND r.next_crawl_at>?)) AND t.current_url LIKE r.origin||'/%')`;
        const seeds = site.seeds ?? [];
        const dueSeeds = seeds.length ? this.all(`${dueSources} AND t.url IN (${seeds.map(()=>'?').join(',')})`,
          site.domain,now,now,...seeds.map(seed=>seed.url)) : [];
        // Compare missed intervals, not raw lateness, so short-period seeds win
        // fairly. Only the small configured set is read and sorted here.
        const overdue = (task: Row) => {
          const configured = configuredSource(task.url)!;
          const interval = configured.pollEveryMs
            ?? Math.max(30_000,Math.ceil(180_000/site.requestsPerMinute))*(configured.kind==='sitemap'?2:1);
          return (now-task.next_crawl_at)/interval;
        };
        const seed = dueSeeds.sort((a,b)=>overdue(b)-overdue(a) || a.next_crawl_at-b.next_crawl_at || a.id-b.id)[0];
        // Non-seeds retain their own durable round-robin position.
        const source = seed ?? this.one(`${dueSources}
          ORDER BY CASE WHEN t.id>? THEN 0 ELSE 1 END,t.id LIMIT 1`,site.domain,now,now,sourceCursor);
        const weights=site.scheduling ?? defaultScheduling;
        const turnKey='discovery-turn:'+site.domain;
        const savedTurn=Number(this.one('SELECT value FROM meta WHERE key=?',turnKey)?.value||0);
        const turn=Number.isSafeInteger(savedTurn)
          ? Math.max(-weights.articleWeight,Math.min(savedTurn,weights.articleWeight+weights.discoveryWeight-1)) : 0;
        // A discovery leaves credit below discoveryWeight, so another early
        // discovery must wait for at least one article slot and repayment of debt.
        const preempt = !!seed && turn>=weights.discoveryWeight && turn<weights.articleWeight;
        let task = source && (turn>=weights.articleWeight || !candidate || preempt) ? source : candidate;
        // Audits only use otherwise idle slots, at most one starting per domain/hour.
        if (!task) task = this.one(`SELECT * FROM crawl_tasks WHERE domain=? AND purpose='audit' AND state='ready' AND next_crawl_at<=?
          AND (hops>0 OR NOT EXISTS(SELECT 1 FROM requests WHERE domain=? AND purpose='audit' AND started>?)) ORDER BY id LIMIT 1`,site.domain,now,site.domain,now-3600_000);
        // A robots chain must finish before its waiting parent can be dispatched.
        const robots = this.one("SELECT * FROM crawl_tasks WHERE domain=? AND purpose='robots' AND state='ready' AND next_crawl_at<=? ORDER BY id LIMIT 1",site.domain,now);
        if (robots) task = robots;
        if (!task) continue;
        const assignedDomain = domainFor(task.current_url);
        if (!assignedDomain || !policy.for(assignedDomain)?.enabled) continue;
        if (this.one("SELECT 1 FROM attempt_assignments WHERE domain=? AND terminal IS NULL",assignedDomain)) continue;
        let delay = 0;
        if (task.purpose !== 'robots') {
          const origin = new URL(task.current_url).origin;
          const cached = this.robotsCache.get(origin,now);
          if (!cached) {
            const url = origin+'/robots.txt';
            this.run(`INSERT INTO crawl_tasks(domain,url,purpose,next_crawl_at,current_url,parent_id,origin)
              VALUES (?,?,'robots',?,?,?,?) ON CONFLICT(url,purpose) DO UPDATE SET state='ready',next_crawl_at=excluded.next_crawl_at,
              current_url=excluded.current_url,hops=0,parent_id=excluded.parent_id
              WHERE crawl_tasks.state='processed' AND crawl_tasks.next_crawl_at<=excluded.next_crawl_at`, assignedDomain,url,now,url,task.id,origin);
            task = this.one("SELECT * FROM crawl_tasks WHERE url=? AND purpose='robots'",url)!;
            if (task.state!=='ready' || task.next_crawl_at>now) continue;
          } else {
            const rules=cached.rules;
            if (rules.isAllowed(task.current_url,UA)===false) { this.fail(task,`robots.txt disallows ${task.current_url}`,true); continue; }
            delay=rules.getCrawlDelay(UA)||0;
          }
        }
        const domain=domainFor(task.current_url);
        const target = domain ? policy.for(domain) : undefined;
        if (!domain || !target?.enabled) continue;
        const slot=reserveSlot(this.db,domain,task.current_url,task.purpose,delay,now);
        if (!slot.id) continue;
        const headers: Record<string,string> = task.hops ? {} : JSON.parse(task.headers);
        if(task.purpose==='robots') Object.assign(headers,this.robotsCache.headers(task.origin,task.current_url));
        if (task.purpose==='discovery' && !task.hops) {
          const s=this.one('SELECT * FROM sources WHERE url=?',task.url)!;
          if(s.etag) headers['If-None-Match']=s.etag;
          if(s.modified) headers['If-Modified-Since']=s.modified;
        }
        const value: Assignment = { task_id:String(task.id),attempt_id:randomUUID(),lease_token:randomUUID(),domain,url:task.current_url,
          purpose:task.purpose,transport:'curl_cffi',fetch_profile:fetchProfileFor(target),headers,timeout_ms:REQUEST_TIMEOUT_MS,max_response_bytes:MAX_RESPONSE_BYTES,
          start_by:new Date(now+DISPATCH_MS).toISOString(),lease_until:new Date(now+LEASE_MS).toISOString() };
        this.run(`INSERT INTO attempt_assignments(attempt_id,request_id,task_id,domain,worker_id,claim_id,lease_token,start_by,lease_until,assignment)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,value.attempt_id,slot.id,task.id,domain,worker,claim,value.lease_token,now+DISPATCH_MS,now+LEASE_MS,JSON.stringify(value));
        // Update in the same transaction as the charge, never during parsing.
        // Robots work is attributed to the parent that required it.
        const allocationKind=task.purpose==='robots'
          ? this.one('SELECT purpose FROM crawl_tasks WHERE id=?',task.parent_id)?.purpose : task.purpose;
        if(allocationKind==='article' || allocationKind==='discovery')
          this.run('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)',turnKey,String(nextTurn(turn,allocationKind,weights,!!candidate)));
        // Seeds, robots prerequisites, skipped sources and replayed claims
        // leave the non-seed source rotation intact.
        if(task.purpose==='discovery' && !configuredSource(task.url))
          this.run('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)',sourceCursorKey,String(task.id));
        if(task.purpose==='article') this.run('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)','article-turns:'+site.domain,String(articleTurns+1));
        this.run("UPDATE crawl_tasks SET state='leased' WHERE id=?",task.id);
        return {task:value};
      }
      return {task:null,retry_after_ms:1000};
    });
  }
  complete(id: string, value: Completion) {
    return this.transaction(() => {
      const a=this.one('SELECT * FROM attempt_assignments WHERE attempt_id=? FOR UPDATE',id);
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
      if (value.fetch_finished_at != null && (typeof value.fetch_finished_at !== 'string'
        || !value.fetch_finished_at.endsWith('Z') || !Number.isFinite(Date.parse(value.fetch_finished_at))
        || !value.started_at || Date.parse(value.fetch_finished_at)<Date.parse(value.started_at)
        || Date.parse(value.fetch_finished_at)>Date.parse(value.finished_at)
        || Date.parse(value.fetch_finished_at)>now)) throw new ContractError('Invalid fetch completion time');
      const sent=value.started_at ? Date.parse(value.started_at) : null;
      const reserved=this.one('SELECT started FROM requests WHERE id=?',a.request_id)!.started;
      if ((sent!==null && (sent<reserved || sent>now || sent>Date.parse(value.finished_at)))
        || Date.parse(value.finished_at)>now) throw new ContractError('Invalid dispatch time');
      let retryUntil=0;
      const finished=value.fetch_finished_at ? Date.parse(value.fetch_finished_at) : now;
      this.run('UPDATE requests SET finished=?,status=?,headers=?,body_hash=?,error=? WHERE id=?',finished,value.status,JSON.stringify(value.headers),value.body_hash,value.error,a.request_id);
      if ([429,503].includes(value.status!)) {
        const retry=value.headers['retry-after']||'300';
        const until=/^\d+$/.test(retry)?now+Number(retry)*1000:Date.parse(retry);
        retryUntil=Math.max(now+60_000,until||0);
      }
      completeSlot(this.db,a.request_id,sent,now,retryUntil);
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
  private reuseArticle(task:Row,now:number):boolean {
    const target=this.aliases.resolve(task.current_url,now);
    if(!target)return false;
    const article=this.one(`SELECT canonical_url FROM articles WHERE canonical_url=? AND classification<>'incomplete'
      AND json_extract(payload,'$.isArticle')='true' AND length(json_extract(payload,'$.text'))>=200`,target);
    if(article) {
      this.run("UPDATE candidates SET state='done',last_error=NULL WHERE url=?",task.url);
      this.run("UPDATE crawl_tasks SET state='processed' WHERE id=?",task.id);
      this.reuse.avoidedDownloads++;return true;
    }
    const response=this.one(`SELECT a.*,r.url response_url,r.body_hash,t.state owner_state,t.id owner_id,t.url owner_url
      FROM requests r JOIN attempt_assignments a ON a.request_id=r.id JOIN crawl_tasks t ON t.id=a.task_id
      WHERE r.url IN (?,?) AND r.purpose='article' AND r.status=200 AND r.error IS NULL
        AND r.body_hash IS NOT NULL ORDER BY r.id DESC LIMIT 1`,task.current_url,target);
    if(!response)return false;
    const defer=()=> {
      this.run('UPDATE crawl_tasks SET next_crawl_at=? WHERE id=?',now+5000,task.id);
      this.run('UPDATE candidates SET next_attempt=? WHERE url=?',now+5000,task.url);
    };
    if(response.processing==='pending') {
      // A failed extraction must not indefinitely prevent a deliberate refetch.
      if(response.process_error && response.process_errors>0)return false;
      defer();this.reuse.pendingArchiveWaits++;return true;
    }
    const replayKey='alias-reparse:'+response.request_id;
    if(response.owner_state!=='processed' || response.processing!=='done'
      || this.one('SELECT value FROM meta WHERE key=?',replayKey)?.value===PARSER_VERSION)return false;
    let bytes:number;
    try {bytes=JSON.parse(response.completion).bytes;}catch{return false;}
    if(!this.archives.valid(response.body_hash,bytes))return false;
    // Reprocess once per parser version before spending another download. The
    // original receipt, fetch/discovery times and budget charge remain untouched.
    this.run('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)',replayKey,PARSER_VERSION);
    this.run("UPDATE attempt_assignments SET processing='pending',process_after=0,process_error=NULL WHERE attempt_id=?",response.attempt_id);
    this.run("UPDATE crawl_tasks SET state='downloaded',current_url=?,hops=0 WHERE id=?",response.response_url,response.owner_id);
    this.run("UPDATE candidates SET state='pending' WHERE url=?",response.owner_url);
    if(response.owner_id!==task.id)defer();
    this.reuse.archivedReparses++;return true;
  }
  fail(task: Row, error: string, denied=false) {
    const target = domainFor(task.current_url);
    if (!policy.for(task.domain)?.enabled || (target && !policy.for(target)?.enabled)) {
      // Preserve the queue if an old lease expires or completes after a pause.
      this.run("UPDATE crawl_tasks SET state='ready' WHERE id=?",task.id);
      return;
    }
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
        this.run('UPDATE crawl_tasks SET next_crawl_at=greatest(next_crawl_at,?) WHERE id=?',due,parent.id);
        if(parent.purpose==='discovery') this.run('UPDATE sources SET next_poll=greatest(next_poll,?),errors=errors+1,last_error=? WHERE url=?',due,error,parent.url);
        if(parent.purpose==='article') this.run('UPDATE candidates SET next_attempt=greatest(next_attempt,?),last_error=? WHERE url=?',due,error,parent.url);
      }
      return;
    }
    if(task.purpose==='discovery') {
      const source=this.one('SELECT * FROM sources WHERE url=?',task.url)!;
      const seed=configuredSource(task.url);
      if(seed || /HTTP (404|410)/.test(error)) this.run('DELETE FROM meta WHERE key=?','source-final:'+task.url);
      if(seed && task.current_url!==task.url) this.run('UPDATE sources SET etag=NULL,modified=NULL WHERE url=?',task.url);
      const permanent=/Response exceeds 5 MiB|Not a supported feed or sitemap/.test(error);
      const due=now+Math.max(configuredSource(source.url)?.pollEveryMs ?? 0,permanent?6*3600_000:denied?3600_000:Math.min(3600_000,30_000*2**source.errors));
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
    const existing=this.one(`SELECT c.*,t.id candidate_task_id,t.state candidate_task_state,t.priority candidate_task_priority
      FROM candidates c LEFT JOIN crawl_tasks t ON t.url=c.url AND t.purpose='article' WHERE c.url=?`,item.url);
    // Settled candidates have no remaining mapping work. Repeated homepage and
    // sitemap links must not issue unused writes or rebuild their tasks.
    if(existing && existing.state!=='pending') return 0;
    const publication=item.published?Date.parse(item.published):null;
    const priority=publication!==null?(publication>=started?100:-10):source.polls>0?urlRecencyPriority(item.url,now):0;
    if(!existing) {
      const count=Number(this.run(`INSERT OR IGNORE INTO candidates(url,domain,source,discovered,published_hint,priority) VALUES (?,?,?,?,?,?)`,item.url,domain,source.url,observed,item.published,priority).changes);
      this.ensureTask(item.url,'article');
      return count;
    }
    let nextPriority=existing.priority;
    // Keep the same hint/priority/discovery rules, but avoid writing rows whose
    // values already match. These mappings run within the caller's transaction.
    if(item.published || ((source.kind==='html' || source.kind.startsWith('html:') || source.kind.startsWith('api:')) && priority>0)) {
      const hint=existing.published_hint ?? item.published;
      nextPriority=Math.max(existing.priority,priority);
      const discovered=Math.min(existing.discovered,observed);
      if(hint!==existing.published_hint || nextPriority!==existing.priority || discovered!==existing.discovered)
        this.run('UPDATE candidates SET published_hint=?,priority=?,discovered=? WHERE url=?',hint,nextPriority,discovered,item.url);
    }
    if(existing.candidate_task_id===null)
      this.run(`INSERT OR IGNORE INTO crawl_tasks(domain,url,purpose,priority,next_crawl_at,current_url) VALUES (?,?,'article',?,?,?)`,existing.domain,item.url,nextPriority,existing.next_attempt,item.url);
    else if(existing.candidate_task_state==='ready' && existing.candidate_task_priority!==nextPriority)
      this.run('UPDATE crawl_tasks SET priority=? WHERE id=?',nextPriority,existing.candidate_task_id);
    return 0;
  }
  private async mapDiscoveryChunks(task: Row, value: Completion, found: ReturnType<typeof discover>) {
    const source=this.one('SELECT * FROM sources WHERE url=?',task.url)!;
    const started=this.one('SELECT started FROM sites WHERE domain=?',task.domain)!.started;
    const observed=Date.parse(fetchFinishedAt(value));
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
    const bytes=this.archives.readVerified(value.body_hash!,value.bytes);
    const charset=value.headers['content-type']?.match(/charset=["']?([^;"'\s]+)/i)?.[1]
      || bytes.subarray(0,2048).toString('ascii').match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] || 'utf-8';
    try { return new TextDecoder(charset).decode(bytes); } catch { return bytes.toString('utf8'); }
  }
  private finishProcessing(a: Row, task: Row, value: Completion, body: string, parsed?: ParseResult) {
    if (!policy.for(task.domain)) return;
    const started=performance.now();
    const exports: {payload:string;fresh:boolean}[]=[];
    this.transaction(()=> {
      if(this.one('SELECT processing FROM attempt_assignments WHERE attempt_id=?',a.attempt_id)?.processing!=='pending') return;
      if(value.error) this.fail(task,value.error);
      else this.apply(task,value,body,exports,parsed,a.request_id,
        this.one('SELECT value FROM meta WHERE key=?','alias-reparse:'+a.request_id)?.value===PARSER_VERSION);
      this.run("UPDATE attempt_assignments SET processing='done',process_error=NULL WHERE attempt_id=?",a.attempt_id);
    });
    const transaction_ms=elapsedMs(started),exportStarted=performance.now();
    for(const item of exports) {
      try { appendFileSync(resolve(this.directory,'articles.jsonl'),item.payload+'\n');
        if(item.fresh) appendFileSync(resolve(this.directory,'new-articles.jsonl'),item.payload+'\n');
      } catch(e) {console.error('JSONL export failed',String(e));}
    }
    timingLog('persist',{attempt_id:a.attempt_id,request_id:a.request_id,domain:task.domain,purpose:task.purpose,
      transaction_ms,export_ms:elapsedMs(exportStarted),total_ms:elapsedMs(started)});
  }
  private processingFailure(a: Row, error: unknown) {
    const message=String(error), task=this.one('SELECT * FROM crawl_tasks WHERE id=?',a.task_id)!;
    if(task.purpose==='discovery' && /Response exceeds 5 MiB|Not a supported feed or sitemap|Truncated RSS contains no complete items/.test(message)) {
      this.transaction(()=> {
        this.fail(task,message);
        this.run("UPDATE attempt_assignments SET processing='done',process_errors=process_errors+1,process_error=? WHERE attempt_id=?",message,a.attempt_id);
      });
    } else this.run('UPDATE attempt_assignments SET process_errors=process_errors+1,process_error=?,process_after=? WHERE attempt_id=?',message,this.clock()+Math.min(3600_000,5000*2**Math.min(a.process_errors,10)),a.attempt_id);
  }
  // Synchronous fixture/recovery helper. Live entry points use processAsync.
  process(limit = 50) {
    if(this.processingJob) return;
    for(const a of this.all(`SELECT a.* FROM attempt_assignments a JOIN crawl_tasks t ON t.id=a.task_id
      WHERE a.processing='pending' AND a.process_after<=? AND t.domain IN (${this.domainParams})
      ORDER BY a.request_id LIMIT ?`,this.clock(),...this.domains,limit)) {
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
  private processControls(limit: number) {
    const controls=this.all(`SELECT a.* FROM attempt_assignments a JOIN crawl_tasks t ON t.id=a.task_id
      JOIN requests r ON r.id=a.request_id WHERE a.processing='pending' AND a.process_after<=?
      AND t.domain IN (${this.domainParams})
      AND (r.error IS NOT NULL OR r.status IS NULL OR r.status<>200 OR t.purpose NOT IN ('article','discovery'))
      ORDER BY a.request_id LIMIT ?`,this.clock(),...this.domains,limit);
    for(const a of controls) {
      try {
        const task=this.one('SELECT * FROM crawl_tasks WHERE id=?',a.task_id)!,value: Completion=JSON.parse(a.completion);
        this.finishProcessing(a,task,value,value.error?'':this.readBody(value));
      } catch(error) {this.processingFailure(a,error);}
    }
  }
  processAsync(): Promise<void> {
    if(this.closing) return Promise.resolve();
    // These bounded synchronous completions can progress while the worker is
    // parsing another archive. They never dispatch a network request.
    this.processControls(8);
    if(this.processingJob) return this.processingJob;
    const selectionStarted=performance.now();
    const a=this.nextProcessing();
    const selection_ms=elapsedMs(selectionStarted);
    if(selection_ms>=100) timingLog('parse_selection',{selection_ms,attempt_id:a?.attempt_id,request_id:a?.request_id});
    if(!a) return Promise.resolve();
    this.processingJob=(async()=> {
      const started=performance.now(),dequeuedAt=this.clock(),durations:Record<string,number>={};
      let phase='load',phaseStarted=started,failed=false,completed=false;
      let task:Row|undefined,value:Completion|undefined,parsed:ParseResult|undefined;
      const next=(name:string)=> {durations[phase+'_ms']=elapsedMs(phaseStarted);phase=name;phaseStarted=performance.now();};
      try {
        task=this.one('SELECT * FROM crawl_tasks WHERE id=?',a.task_id)!;
        value=JSON.parse(a.completion) as Completion;
        let body='';
        next('parse_roundtrip');
        if(!value.error && value.status===200 && ['article','discovery'].includes(task.purpose)) {
          const common={response_ref:value.response_ref!,body_hash:value.body_hash!,bytes:value.bytes,headers:value.headers,url:task.current_url};
          if(task.purpose==='discovery') parsed=await this.parser.parse({...common,kind:'discovery',sourceKind:this.one('SELECT kind FROM sources WHERE url=?',task.url)!.kind});
          else {
            const item=this.one('SELECT discovered,published_hint FROM candidates WHERE url=?',task.url)!;
            parsed=await this.parser.parse({...common,kind:'article',discovered:item.discovered,hint:item.published_hint});
          }
        } else if(!value.error) body=this.readBody(value);
        next('mapping');
        if(parsed?.kind==='discovery') {
          const source=this.one('SELECT * FROM sources WHERE url=?',task.url)!;
          const started=this.one('SELECT started FROM sites WHERE domain=?',task.domain)!.started;
          const mappingKey=createHash('sha256').update(JSON.stringify([MAPPING_VERSION,value.body_hash,task.current_url,
            source.kind,source.polls>0,source.depth,started,Math.floor(this.clock()/86400_000)])).digest('hex');
          const completed=this.one('SELECT value FROM meta WHERE key=?','mapping:'+task.url)?.value;
          if(!parsed.found.partial && completed===mappingKey)this.reuse.mappingSkips++;
          else if(!await this.mapDiscoveryChunks(task,value,parsed.found)) return;
          parsed={...parsed,found:{...parsed.found,articles:[]},mappingKey};
        }
        // Parsing and decompression above happen without holding a write lock.
        next('persist');
        this.finishProcessing(a,task,value,body,parsed);
        completed=true;
      } catch(error) {failed=true;if(!this.closing)this.processingFailure(a,error);}
      finally {
        durations[phase+'_ms']=elapsedMs(phaseStarted);
        timingLog('processing',{attempt_id:a.attempt_id,request_id:a.request_id,domain:a.domain,purpose:task?.purpose,
          failed,completed,failed_phase:failed?phase:null,queue_wait_ms:value?dequeuedAt-Date.parse(value.finished_at):null,
          fetch_to_parse_ms:value?dequeuedAt-Date.parse(fetchFinishedAt(value)):null,
          selection_ms,...durations,total_ms:elapsedMs(started),extraction_cache_hit:parsed?.cache?.hit,
          ...parsed?.timings});
      }
    })().finally(()=> {this.processingJob=undefined;if(!this.closing) setImmediate(()=>void this.processAsync().catch(error=>console.error('archive processing failed',error)));});
    return this.processingJob;
  }
  private nextProcessing(): Row | undefined {
    const now=this.clock();
    const base=`SELECT a.* FROM attempt_assignments a JOIN crawl_tasks t ON t.id=a.task_id
      JOIN requests r ON r.id=a.request_id WHERE a.processing='pending' AND a.process_after<=?
      AND t.domain IN (${this.domainParams}) AND r.status=200 AND r.error IS NULL`;
    // Inspect a new source's first response promptly, then drain established
    // sources in arrival order. This changes parsing order, never poll budgets.
    const discovery=()=>this.one(base+` AND t.purpose='discovery'
      ORDER BY coalesce((SELECT polls FROM sources WHERE url=t.url),0)=0 DESC,a.request_id LIMIT 1`,now,...this.domains);
    if(this.articlesSinceDiscovery>=3) {
      const a=discovery();
      if(a) {this.articlesSinceDiscovery=0;return a;}
    }
    // Keep fresh articles timely, while one in five turns drains older archives.
    const direction=this.articleParses%5===4?'ASC':'DESC';
    const article=this.one(base+` AND t.purpose='article' ORDER BY a.request_id ${direction} LIMIT 1`,now,...this.domains);
    if(article) {this.articlesSinceDiscovery++;this.articleParses++;return article;}
    const a=discovery();
    if(a)this.articlesSinceDiscovery=0;
    return a;
  }
  async close() {
    this.closing=true;
    const current=this.processingJob;
    // Cancel first: waiting for the parser watchdog could outlast systemd's
    // shutdown deadline. An interrupted archive remains pending for restart.
    await Promise.all([this.parser.close(),current]);
  }
  apply(task: Row, value: Completion, body: string, exports: {payload:string;fresh:boolean}[], parsed?: ParseResult, requestId?:number, replayed=false) {
    const now=this.clock(), status=value.status!;
    if(status>=300 && status<400 && status!==304 && value.headers.location) {
      if(task.hops>=5) {this.fail(task,'Too many redirects');return;}
      let next:string; try {next=new URL(value.headers.location,task.current_url).href;} catch {this.fail(task,'Invalid redirect');return;}
      if(!domainFor(next)) {this.fail(task,'URL is outside configured domains',true);return;}
      if(task.purpose==='article' && requestId && [301,308].includes(status))
        this.reuse.aliasesRecorded+=this.aliases.remember(task.current_url,next,'redirect',requestId,Date.parse(fetchFinishedAt(value)));
      this.run("UPDATE crawl_tasks SET state='ready',current_url=?,hops=hops+1,next_crawl_at=? WHERE id=?",next,now,task.id);
      return;
    }
    if(task.purpose==='robots') {
      let policy;
      if(status===304) {
        policy=this.robotsCache.renew(task.origin,task.current_url,now,value.headers);
        if(!policy) {this.fail(task,'robots.txt returned 304 without a cached policy');return;}
      } else {
        let ttl=ROBOTS_TTL_MS,conditional=true;
        if([401,403].includes(status)) {body='User-agent: *\nDisallow: /';ttl=ROBOTS_DENIED_TTL_MS;conditional=false;}
        else if([404,410].includes(status)) {body='';conditional=false;}
        else if(status>=400) {this.fail(task,`robots.txt HTTP ${status}`);return;}
        else if(/<html[\s>]/i.test(body)) {
          // A redirect that leaves /robots.txt and ends on an HTML page is a soft
          // 404: the origin has no robots file. HTML served at /robots.txt itself
          // may be a block page, so that case still fails closed.
          if(!task.hops || new URL(task.current_url).pathname==='/robots.txt') {this.fail(task,'robots.txt returned HTML');return;}
          body='';conditional=false;
        }
        policy=this.robotsCache.save(task.origin,task.current_url,body,now,ttl,value.headers,conditional);
      }
      const auditParent=task.parent_id && this.one('SELECT purpose FROM crawl_tasks WHERE id=?',task.parent_id)?.purpose==='audit';
      // Robots fetched only for an external audit must not seed crawler discovery.
      for(const map of auditParent?[]:policy.rules.getSitemaps()
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
    const site=policy.for(task.domain);
    if (!site) return;
    const started=this.one('SELECT started FROM sites WHERE domain=?',site.domain)!.started;
    if(task.purpose==='discovery') {
      if(status!==200 && status!==304) {this.fail(task,`HTTP ${status}`);return;}
      const source=this.one('SELECT * FROM sources WHERE url=?',task.url)!;
      const observed=Date.parse(fetchFinishedAt(value));
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
      const seed=configuredSource(task.url);
      const nextUrl=seed ? task.url : task.current_url;
      // Validators belong to the fetched URL, not a different redirect origin.
      const clearValidators=partial || nextUrl!==task.current_url;
      // Do not cache a partial response: next poll must request the complete body.
      this.run('UPDATE sources SET polls=polls+1,errors=?,last_error=?,next_poll=?,discovered=discovered+?,etag=?,modified=? WHERE url=?',partial?source.errors+1:0,partial?'Partial discovery response: only valid items processed':null,due,count,clearValidators?null:(value.headers.etag??source.etag),clearValidators?null:(value.headers['last-modified']??source.modified),task.url);
      if(seed) this.run('DELETE FROM meta WHERE key=?','source-final:'+task.url);
      else this.run('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)','source-final:'+task.url,task.current_url);
      if(!partial && parsed?.mappingKey)
        this.run('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)','mapping:'+task.url,parsed.mappingKey);
      this.run("UPDATE crawl_tasks SET state='ready',hops=0,next_crawl_at=?,current_url=? WHERE id=?",due,nextUrl,task.id);
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
      else if(classification!=='incomplete') {
        const existing=this.one("SELECT * FROM articles WHERE canonical_url=? AND classification='incomplete'",article.canonicalUrl);
        if(existing) {
          const original=JSON.parse(existing.payload);
          const repairedClass=classify(article.publishedAt,started,existing.discovered,duplicate,true);
          const repaired=JSON.stringify({...article,classification:repairedClass,domain:site.domain,
            sourceUrl:original.sourceUrl,discoveredAt:original.discoveredAt,fetchedAt:original.fetchedAt,reprocessedAt:new Date(now).toISOString()});
          this.run('UPDATE articles SET published=?,classification=?,fingerprint=?,payload=? WHERE canonical_url=?',article.publishedAt,repairedClass,fingerprint,repaired,article.canonicalUrl);
          exports.push({payload:repaired,fresh:false});
        }
      }
      if(requestId && classification!=='incomplete')
        this.reuse.aliasesRecorded+=this.aliases.remember(task.current_url,article.canonicalUrl,'canonical',requestId,Date.parse(fetchFinishedAt(value)));
      this.run("UPDATE candidates SET state='done',attempts=attempts+?,last_error=NULL WHERE url=?",replayed?0:1,task.url);
      this.run("UPDATE crawl_tasks SET state='processed' WHERE id=?",task.id);
      this.run('UPDATE scheduler_domains SET articles_since_poll=articles_since_poll+1 WHERE domain=?',site.domain);
    }
  }
}
