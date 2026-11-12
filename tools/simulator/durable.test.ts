import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Scheduler } from '../../services/crawler/src/scheduler/durable.js';
import { schedulerServer } from '../../services/crawler/src/scheduler/server.js';
import { migrateDurable } from '../../packages/db/src/migrations/durable.js';
import type { Assignment, Completion } from '../../packages/protocol/src/index.js';

function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'durable-'));mkdirSync(join(dir,'snapshots'));
  const path=join(dir,'crawler.sqlite'); const db=new DatabaseSync(path);
  db.exec(readFileSync(new URL('../../packages/db/src/store.ts',import.meta.url),'utf8').match(/db.exec\(`([\s\S]+?)`\);/)![1]);
  db.prepare('INSERT INTO sites VALUES (?,?,?)').run('bbc.com',0,0);
  db.prepare("INSERT INTO sources(url,domain,kind) VALUES (?,'bbc.com','html')").run('https://www.bbc.com/');
  db.prepare('INSERT INTO robots VALUES (?,?,?)').run('https://www.bbc.com','User-agent: *\nAllow: /',9e12);
  let now=1_000_000;
  const scheduler=new Scheduler(db,dir,()=>now);
  return {dir,path,db,scheduler,advance:(ms=100_000)=>now+=ms,now:()=>now,close:()=>{db.close();rmSync(dir,{recursive:true,force:true});}};
}
function response(f:ReturnType<typeof fixture>,task:Assignment,status=200,body='<html></html>',headers:Record<string,string>={}): Completion {
  const bytes=Buffer.from(body),hash=createHash('sha256').update(bytes).digest('hex');
  writeFileSync(join(f.dir,'snapshots',hash+'.gz'),gzipSync(bytes));
  return {lease_token:task.lease_token,started_at:new Date(f.now()).toISOString(),finished_at:new Date(f.now()).toISOString(),status,headers,body_hash:hash,response_ref:`snapshots/${hash}.gz`,bytes:bytes.length,error:null};
}
test('migration/backfill is repeatable, preserves due times, existing schema and ledger',()=> {
  const f=fixture();try {
    f.db.exec("UPDATE sources SET next_poll=9999999; DELETE FROM crawl_tasks; INSERT INTO candidates(url,domain,source,discovered,priority,next_attempt) VALUES ('https://www.bbc.com/a','bbc.com','x',1,50,8888888)");
    const before=f.db.prepare('SELECT * FROM sites').all();
    migrateDurable(f.db);migrateDurable(f.db);
    assert.deepEqual(f.db.prepare('SELECT next_crawl_at FROM crawl_tasks ORDER BY purpose').all().map(r=>r.next_crawl_at),[8888888,9999999]);
    assert.deepEqual(f.db.prepare('SELECT * FROM sites').all(),before);
    assert.equal(f.scheduler.claim('w','no-due').task,null);
  } finally {f.close();}
});
test('HTTP concurrent claims and completion retries are idempotent; reopen preserves active lease',async()=> {
  const f=fixture(),server=schedulerServer(f.scheduler);
  await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok));
  const base=`http://127.0.0.1:${(server.address() as any).port}`;
  const post=async(path:string,data:unknown)=>{const r=await fetch(base+path,{method:'POST',body:JSON.stringify(data)});return {status:r.status,body:await r.json() as any};};
  try {
    const results=await Promise.all(Array.from({length:12},(_,i)=>post('/internal/claims',{worker_id:'w',claim_id:'c'+i})));
    const assigned=results.map(r=>r.body.task).filter(Boolean);assert.equal(assigned.length,1);
    const task=assigned[0];
    assert.deepEqual((await post('/internal/claims',{worker_id:'w',claim_id:'c0'})).body.task,task);
    const second=new DatabaseSync(f.path);second.exec('PRAGMA busy_timeout=5000');
    try {assert.equal(new Scheduler(second,f.dir,f.now).claim('other','new').task,null);}finally{second.close();}
    assert.equal(f.db.prepare('SELECT count(*) n FROM requests').get()!.n,1);
    const value=response(f,task,304,'');
    const path=`/internal/attempts/${task.attempt_id}/complete`;
    assert.equal((await post(path,{...value,lease_token:'bad'})).status,403);
    assert.deepEqual(await post(path,value),await post(path,value));
    await f.scheduler.processAsync();await f.scheduler.processAsync();
    assert.equal(f.db.prepare('SELECT polls FROM sources').get()!.polls,1);
    assert.equal(f.db.prepare('SELECT count(*) n FROM requests').get()!.n,1);
    assert.equal((await post('/internal/claims',{worker_id:'w',claim_id:'c0'})).body.task.attempt_id,task.attempt_id);
  }finally{await new Promise<void>(ok=>server.close(()=>ok()));f.close();}
});
test('expired attempts stay charged, cannot overlap, late completion cannot overwrite new state',()=> {
  const f=fixture();try{
    const task=f.scheduler.claim('w','1').task!;
    f.advance(59_999);assert.equal(f.scheduler.claim('w','2').task,null);
    f.advance(2);f.scheduler.recover();
    assert.equal(f.db.prepare('SELECT terminal FROM attempt_assignments').get()!.terminal,'expired');
    assert.equal(f.db.prepare('SELECT count(*) n FROM requests').get()!.n,1);
    assert.equal(f.scheduler.complete(task.attempt_id,response(f,task)).outcome,'expired');
    assert.equal(f.db.prepare('SELECT polls FROM sources').get()!.polls,0);
    assert.equal(f.scheduler.claim('w','3').task,null); // backoff + budget spacing
    f.advance();assert.ok(f.scheduler.claim('w','4').task);
  }finally{f.close();}
});
test('processing failure retries archived data without another fetch or successful observation',()=> {
  const f=fixture();try{
    const task=f.scheduler.claim('w','1').task!,value=response(f,task);
    const bytes=readFileSync(join(f.dir,value.response_ref!));rmSync(join(f.dir,value.response_ref!));
    f.scheduler.complete(task.attempt_id,value);f.scheduler.process();
    assert.equal(f.db.prepare('SELECT polls FROM sources').get()!.polls,0);
    assert.equal(f.db.prepare('SELECT state FROM crawl_tasks').get()!.state,'downloaded');
    assert.equal(f.scheduler.claim('w','2').task,null);
    writeFileSync(join(f.dir,value.response_ref!),bytes);f.advance(5001);
    new Scheduler(f.db,f.dir,f.now).recover();
    assert.equal(f.db.prepare('SELECT polls FROM sources').get()!.polls,1);
    assert.equal(f.db.prepare('SELECT count(*) n FROM requests').get()!.n,1);
  }finally{f.close();}
});
test('robots denial, redirects, 304s and 429 cooldown retain request accounting and source semantics',()=> {
  const f=fixture();try{
    f.db.exec('DELETE FROM robots');
    let task=f.scheduler.claim('w','1').task!;assert.equal(task.purpose,'robots');
    f.scheduler.complete(task.attempt_id,response(f,task,200,'User-agent: *\nDisallow: /'));f.scheduler.process();
    f.advance();assert.equal(f.scheduler.claim('w','2').task,null);
    assert.equal(f.db.prepare('SELECT polls FROM sources').get()!.polls,0);
    assert.match(String(f.db.prepare('SELECT last_error FROM sources').get()!.last_error),/disallows/);
    f.db.exec("UPDATE robots SET body='User-agent: *\nAllow: /'; UPDATE sources SET next_poll=0; UPDATE crawl_tasks SET next_crawl_at=0 WHERE purpose='discovery'");
    task=f.scheduler.claim('w','3').task!;
    f.scheduler.complete(task.attempt_id,response(f,task,302,'',{location:'/new'}));f.scheduler.process();
    assert.equal(f.db.prepare('SELECT polls FROM sources').get()!.polls,0);
    assert.equal(f.scheduler.claim('w','4').task,null);
    f.advance();task=f.scheduler.claim('w','5').task!;assert.equal(task.url,'https://www.bbc.com/new');
    f.scheduler.complete(task.attempt_id,response(f,task,429,'',{'retry-after':'600'}));f.scheduler.process();
    assert.equal(f.db.prepare('SELECT cooldown FROM sites').get()!.cooldown,f.now()+600000);
    assert.equal(f.db.prepare('SELECT polls FROM sources').get()!.polls,0);
    f.advance();assert.equal(f.scheduler.claim('w','6').task,null);
    f.advance(600000);task=f.scheduler.claim('w','7').task!;
    f.scheduler.complete(task.attempt_id,response(f,task,304,''));f.scheduler.process();
    assert.equal(f.db.prepare('SELECT polls FROM sources').get()!.polls,1);
  }finally{f.close();}
});
test('article pipeline retains extraction/classification and completes once',()=> {
  const f=fixture();try{
    f.db.exec("UPDATE sources SET next_poll=999999999; UPDATE crawl_tasks SET next_crawl_at=999999999; INSERT INTO candidates(url,domain,source,discovered,priority) VALUES ('https://www.bbc.com/news/articles/100001','bbc.com','x',900000,100)");
    migrateDurable(f.db);
    const task=f.scheduler.claim('w','1').task!;assert.equal(task.purpose,'article');
    const value=response(f,task,200,readFileSync(new URL('../../fixtures/article.html',import.meta.url),'utf8'));
    f.scheduler.complete(task.attempt_id,value);f.scheduler.process();
    f.scheduler.complete(task.attempt_id,value);f.scheduler.process();
    const row=f.db.prepare('SELECT * FROM articles').get()!;
    assert.equal(row.fetched,f.now());assert.equal(f.db.prepare('SELECT count(*) n FROM articles').get()!.n,1);
    assert.equal(f.db.prepare('SELECT attempts FROM candidates').get()!.attempts,1);
    assert.equal(JSON.parse(String(row.payload)).text.length>=200,true);
  }finally{f.close();}
});

test('parser exception rolls back mapping and retries the archive after restart',()=>{
  const f=fixture();try{
    const task=f.scheduler.claim('w','parse').task!;f.scheduler.complete(task.attempt_id,response(f,task));
    f.scheduler.apply=()=>{throw new Error('simulated parser failure');};f.scheduler.process();
    assert.equal(f.db.prepare('SELECT polls FROM sources').get()!.polls,0);
    f.advance(5001);new Scheduler(f.db,f.dir,f.now).recover();
    assert.equal(f.db.prepare('SELECT polls FROM sources').get()!.polls,1);
    assert.equal(f.db.prepare('SELECT count(*) n FROM requests').get()!.n,1);
  }finally{f.close();}
});

test('independent scheduler processes cannot reserve two assignments for one domain',async()=>{
  const {spawn}=await import('node:child_process');const f=fixture();
  const code=`import {DatabaseSync} from 'node:sqlite';
    import {Scheduler} from ${JSON.stringify(new URL('../../services/crawler/src/scheduler/durable.ts',import.meta.url).href)};
    const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA busy_timeout=5000');
    console.log(JSON.stringify(new Scheduler(db,process.argv[2],()=>1000000).claim('w',process.argv[3])));db.close();`;
  const claim=(id:string)=>new Promise<any>((ok,fail)=>{
    const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',code,f.path,f.dir,id]);let out='',err='';
    child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.on('error',fail);child.on('exit',status=>status===0?ok(JSON.parse(out)):fail(new Error(err)));
  });
  try{const result=await Promise.all([claim('a'),claim('b')]);assert.equal(result.filter(x=>x.task).length,1);assert.equal(f.db.prepare('SELECT count(*) n FROM requests').get()!.n,1);}
  finally{f.close();}
});

test('external audit uses durable budget, remains low priority, and never creates discoveries',()=>{
  const f=fixture();try{
    f.db.prepare("INSERT INTO crawl_tasks(domain,url,purpose,next_crawl_at,current_url) VALUES ('bbc.com',?,'audit',0,?)").run('https://www.bbc.com/news/audit','https://www.bbc.com/news/audit');
    const source=f.scheduler.claim('w','source-first').task!;assert.equal(source.purpose,'discovery');
    f.scheduler.complete(source.attempt_id,response(f,source,304,''));f.scheduler.process();
    f.db.exec("UPDATE crawl_tasks SET next_crawl_at=999999999 WHERE purpose='discovery'");
    assert.equal(f.scheduler.claim('w','still-budgeted').task,null);
    f.advance();const audit=f.scheduler.claim('w','audit').task!;assert.equal(audit.purpose,'audit');
    f.scheduler.complete(audit.attempt_id,response(f,audit,200,readFileSync(new URL('../../fixtures/article.html',import.meta.url),'utf8')));f.scheduler.process();
    assert.equal(f.db.prepare('SELECT count(*) n FROM articles').get()!.n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM candidates').get()!.n,0);
    assert.equal(f.db.prepare("SELECT count(*) n FROM requests WHERE purpose='audit'").get()!.n,1);
    f.db.prepare("INSERT INTO crawl_tasks(domain,url,purpose,next_crawl_at,current_url) VALUES ('bbc.com',?,'audit',0,?)").run('https://www.bbc.com/news/another','https://www.bbc.com/news/another');
    f.advance();assert.equal(f.scheduler.claim('w','hour-cap').task,null);
    f.advance(3600000);const failed=f.scheduler.claim('w','later').task!;assert.equal(failed.purpose,'audit');
    f.scheduler.complete(failed.attempt_id,{...response(f,failed),error:'timeout'});f.scheduler.process();
    assert.equal(f.db.prepare("SELECT state FROM crawl_tasks WHERE id=?").get(Number(failed.task_id))!.state,'processed');
  }finally{f.close();}
});

test('robots fetched for an external audit cannot seed discovery sources',()=>{
  const f=fixture();try{
    f.db.exec("DELETE FROM robots;UPDATE crawl_tasks SET next_crawl_at=999999999;INSERT INTO crawl_tasks(domain,url,purpose,next_crawl_at,current_url) VALUES ('bbc.com','https://www.bbc.com/external','audit',0,'https://www.bbc.com/external')");
    const task=f.scheduler.claim('w','audit-robots').task!;assert.equal(task.purpose,'robots');
    f.scheduler.complete(task.attempt_id,response(f,task,200,'User-agent: *\nAllow: /\nSitemap: https://www.bbc.com/external-sitemap.xml'));f.scheduler.process();
    assert.equal(f.db.prepare('SELECT count(*) n FROM sources').get()!.n,1);
    assert.equal(f.db.prepare('SELECT count(*) n FROM candidates').get()!.n,0);
  }finally{f.close();}
});

test('failed archive processing does not block other tasks on the same domain',()=>{
  const f=fixture();try {
    const task=f.scheduler.claim('w','bad-archive').task!;
    const value=response(f,task);rmSync(join(f.dir,value.response_ref!));
    f.scheduler.complete(task.attempt_id,value);f.scheduler.process();
    f.db.exec("INSERT INTO candidates(url,domain,source,discovered,priority) VALUES ('https://www.bbc.com/news/healthy','bbc.com','x',999999,100)");
    f.scheduler.ensureTask('https://www.bbc.com/news/healthy','article');
    f.advance();
    const next=f.scheduler.claim('w','healthy').task!;
    assert.equal(next.url,'https://www.bbc.com/news/healthy');
    assert.equal(f.db.prepare('SELECT state FROM crawl_tasks WHERE id=?').get(Number(task.task_id))!.state,'downloaded');
  }finally{f.close();}
});

test('failed robots origin backs off across restart without starving healthy origins',()=>{
  const f=fixture();try {
    f.db.exec("INSERT INTO candidates(url,domain,source,discovered,priority) VALUES ('https://broken.bbc.com/news/broken','bbc.com','x',999999,100)");
    f.scheduler.ensureTask('https://broken.bbc.com/news/broken','article');
    f.db.exec('UPDATE scheduler_domains SET articles_since_poll=0');
    const task=f.scheduler.claim('w','broken-robots').task!;assert.equal(task.purpose,'robots');
    f.scheduler.complete(task.attempt_id,response(f,task,200,'<html>Not robots</html>'));f.scheduler.process();
    f.db.exec("INSERT INTO candidates(url,domain,source,discovered,priority) VALUES ('https://broken.bbc.com/news/another','bbc.com','x',1000000,100)");
    f.scheduler.ensureTask('https://broken.bbc.com/news/another','article');
    f.advance();
    const next=new Scheduler(f.db,f.dir,f.now).claim('w','healthy-origin').task!;
    assert.equal(next.url,'https://www.bbc.com/');
    assert.equal(f.db.prepare("SELECT count(*) n FROM requests WHERE purpose='robots'").get()!.n,1);
    assert.equal(f.db.prepare("SELECT attempts FROM candidates WHERE url LIKE '%/broken'").get()!.attempts,0);
  }finally{f.close();}
});

test('partial RSS processes only closed items and retries without conditional caching',()=>{
  const f=fixture();try {
    f.db.exec("UPDATE sources SET kind='feed',etag='old'");
    const task=f.scheduler.claim('w','partial-rss').task!;
    const body='<rss><channel><item><link>https://www.bbc.com/news/whole</link><pubDate>1970-01-01T00:16:00Z</pubDate></item><item><link>https://www.bbc.com/news/broken</link><enclosure url="unfinished';
    f.scheduler.complete(task.attempt_id,response(f,task,200,body,{etag:'partial'}));f.scheduler.process();
    const source=f.db.prepare('SELECT * FROM sources').get()!;
    assert.equal(source.polls,1);assert.equal(source.etag,null);assert.match(String(source.last_error),/Partial RSS/);
    assert.equal(f.db.prepare('SELECT count(*) n FROM candidates').get()!.n,1);
    assert.equal(f.db.prepare('SELECT url FROM candidates').get()!.url,'https://www.bbc.com/news/whole');
    assert.equal(f.db.prepare('SELECT processing FROM attempt_assignments').get()!.processing,'done');
  }finally{f.close();}
});

test('a repeated homepage link leaves the initial sample queue without rewriting discovery time',()=>{
  const f=fixture();try {
    const url='https://www.bbc.com/news/articles/100000000';
    f.db.prepare("INSERT INTO candidates(url,domain,source,discovered,priority) VALUES (?,'bbc.com','https://www.bbc.com/',1234,0)").run(url);
    f.db.exec('UPDATE sources SET polls=1');
    const task=f.scheduler.claim('w','homepage-again').task!;
    f.scheduler.complete(task.attempt_id,response(f,task,200,'<html><a href="'+url+'">A current headline on the homepage</a></html>'));f.scheduler.process();
    const row=f.db.prepare('SELECT * FROM candidates WHERE url=?').get(url)!;
    assert.equal(row.priority,50);assert.equal(row.discovered,1234);assert.equal(row.published_hint,null);
    f.advance();assert.equal(f.scheduler.claim('w','article').task!.url,url);
  }finally{f.close();}
});

test('recent publication outranks bulk discovery while every fifth article drains old positive backlog',()=>{
  const f=fixture();try {
    f.db.exec("UPDATE sources SET next_poll=999999999;UPDATE crawl_tasks SET next_crawl_at=999999999");
    const insert=f.db.prepare("INSERT INTO candidates(url,domain,source,discovered,published_hint,priority) VALUES (?,'bbc.com','x',?,?,100)");
    insert.run('https://www.bbc.com/news/old-backlog',1,new Date(0).toISOString());
    for(let i=0;i<6;i++) insert.run('https://www.bbc.com/news/fresh-'+i,900000-i,new Date(f.now()-1000-i*1000).toISOString());
    migrateDurable(f.db);
    for(let i=0;i<5;i++) {
      const task=f.scheduler.claim('w','freshness-'+i).task!;
      assert.equal(task.url,i===4?'https://www.bbc.com/news/old-backlog':'https://www.bbc.com/news/fresh-'+i);
      f.scheduler.complete(task.attempt_id,response(f,task,404));f.scheduler.process();f.advance();
    }
    assert.equal(f.db.prepare("SELECT value FROM meta WHERE key='article-turns:bbc.com'").get()!.value,'5');
  }finally{f.close();}
});

test('archived sources do not consume slots needed for current news sitemaps',()=>{
  const f=fixture();try {
    for(let i=0;i<20;i++) f.db.prepare("INSERT INTO sources(url,domain,kind) VALUES (?,'bbc.com','sitemap')").run('https://www.bbc.com/archive-'+i+'.xml');
    const task=f.scheduler.claim('w','index').task!;
    f.scheduler.complete(task.attempt_id,response(f,task,200,'<sitemapindex><sitemap><loc>https://www.bbc.com/news-latest.xml</loc></sitemap></sitemapindex>'));f.scheduler.process();
    assert.ok(f.db.prepare("SELECT 1 FROM sources WHERE url='https://www.bbc.com/news-latest.xml'").get());
  }finally{f.close();}
});

test('proven empty source yields to usable new articles while a quiet sole source keeps its cadence',()=>{
  const f=fixture();try {
    for(let i=0;i<3;i++) {
      const task=f.scheduler.claim('w','empty-'+i).task!;
      f.scheduler.complete(task.attempt_id,response(f,task,304,''));f.scheduler.process();f.advance();
    }
    f.scheduler.refreshSourceQuality();
    const empty=f.db.prepare('SELECT * FROM sources').get()!;
    assert.equal(f.scheduler.sourceInterval(empty,60000),60000);
    const url='https://www.bbc.com/news/usable';
    f.db.prepare("INSERT INTO sources(url,domain,kind) VALUES ('https://www.bbc.com/latest.xml','bbc.com','feed')").run();
    f.db.prepare("INSERT INTO candidates(url,domain,source,discovered,priority,state) VALUES (?,'bbc.com','https://www.bbc.com/latest.xml',1,100,'done')").run(url);
    f.db.prepare("INSERT INTO articles VALUES (?,'bbc.com',1,?,'1970-01-01T00:00:00Z','new','fingerprint','{}')").run(url,f.now());
    f.scheduler.refreshSourceQuality();
    assert.equal(f.scheduler.sourceInterval(empty,60000),300000);
  }finally{f.close();}
});

test('successful discovery redirects become next poll destination with conditional headers',()=>{
  const f=fixture();try {
    let task=f.scheduler.claim('w','original').task!;
    f.scheduler.complete(task.attempt_id,response(f,task,302,'',{location:'/latest.xml'}));f.scheduler.process();f.advance();
    task=f.scheduler.claim('w','redirect').task!;assert.equal(task.url,'https://www.bbc.com/latest.xml');
    f.scheduler.complete(task.attempt_id,response(f,task,200,'<rss><channel/></rss>',{etag:'version-1'}));f.scheduler.process();f.advance();
    task=f.scheduler.claim('w','next-poll').task!;
    assert.equal(task.url,'https://www.bbc.com/latest.xml');assert.equal(task.headers['If-None-Match'],'version-1');
    assert.equal(f.db.prepare('SELECT url FROM sources').get()!.url,'https://www.bbc.com/');
    f.scheduler.complete(task.attempt_id,response(f,task,404));f.scheduler.process();f.advance();
    assert.equal(f.scheduler.claim('w','expired-redirect').task!.url,'https://www.bbc.com/');
  }finally{f.close();}
});

test('permanent unsupported source format backs off six hours rather than retrying the same archive',()=>{
  const f=fixture();try {
    f.db.exec("UPDATE sources SET kind='feed'");
    const task=f.scheduler.claim('w','unsupported').task!;
    f.scheduler.complete(task.attempt_id,response(f,task,200,'<unsupported/>'));f.scheduler.process();
    assert.equal(f.db.prepare('SELECT next_poll FROM sources').get()!.next_poll,f.now()+6*3600000);
    assert.equal(f.db.prepare('SELECT processing FROM attempt_assignments').get()!.processing,'done');
    assert.match(String(f.db.prepare('SELECT last_error FROM sources').get()!.last_error),/Not a supported/);
  }finally{f.close();}
});

test('live archive parsing leaves the write lock free and permits claims while its worker runs',async()=>{
  const f=fixture();try {
    const task=f.scheduler.claim('w','source').task!;
    const body='<rss><channel>'+Array.from({length:500},(_,i)=>'<item><link>https://www.bbc.com/news/large-'+i+'</link></item>').join('')+'</channel></rss>';
    f.scheduler.complete(task.attempt_id,response(f,task,200,body));
    const parsing=f.scheduler.processAsync();
    assert.equal(f.db.isTransaction,false);
    f.db.exec("INSERT INTO candidates(url,domain,source,discovered,priority) VALUES ('https://www.bbc.com/news/parallel','bbc.com','x',999999,100)");f.scheduler.ensureTask('https://www.bbc.com/news/parallel','article');f.advance();
    assert.equal(f.scheduler.claim('w','parallel').task!.url,'https://www.bbc.com/news/parallel');
    await parsing;
    assert.equal(f.db.prepare('SELECT polls FROM sources').get()!.polls,1);
    assert.equal(f.db.prepare('SELECT processing FROM attempt_assignments WHERE attempt_id=?').get(task.attempt_id)!.processing,'done');
  }finally{await f.scheduler.close();f.close();}
});

test('source discovery and next poll use fetch finish even when parsing runs later',()=>{
  const f=fixture();try {
    const task=f.scheduler.claim('w','delayed-parse').task!;
    const finished=f.now();
    f.scheduler.complete(task.attempt_id,response(f,task,200,'<html><a href="https://www.bbc.com/news/article-1234567">A headline found in this response</a></html>'));
    f.advance(10000);f.scheduler.process();
    assert.equal(f.db.prepare('SELECT discovered FROM candidates').get()!.discovered,finished);
    assert.equal(f.db.prepare('SELECT next_poll FROM sources').get()!.next_poll,finished+36000);
  }finally{f.close();}
});

test('URL dates only rank recent links and never become publication evidence',async()=>{
  const {urlRecencyPriority}=await import('../../config/discovery.js');
  const now=Date.parse('2026-11-12T08:00:00Z');
  assert.equal(urlRecencyPriority('https://finance.sina.com.cn/roll/2026-11-12/doc-a.shtml',now),75);
  assert.equal(urlRecencyPriority('https://finance.sina.com.cn/roll/2026-11-11/doc-b.shtml',now),75);
  assert.equal(urlRecencyPriority('https://finance.sina.com.cn/roll/2026-09-30/doc-c.shtml',now),50);
  const f=fixture();try {
    f.advance(now-f.now());f.db.exec('UPDATE sources SET polls=1');
    const task=f.scheduler.claim('w','url-hint').task!;
    f.scheduler.complete(task.attempt_id,response(f,task,200,'<a href="https://www.bbc.com/news/2026-11-12/story-1234567">A story with a dated URL</a>'));f.scheduler.process();
    const row=f.db.prepare('SELECT priority,published_hint FROM candidates').get()!;
    assert.equal(row.priority,75);assert.equal(row.published_hint,null);
  }finally{f.close();}
});

test('interrupted chunked discovery replays without double counting or premature source success',async()=>{
  const f=fixture();let restarted: Scheduler|undefined;let stopped: Promise<void>|undefined;
  try {
    const task=f.scheduler.claim('w','chunked').task!,finished=f.now();
    const body='<rss><channel>'+Array.from({length:250},(_,i)=>'<item><link>https://www.bbc.com/news/chunk-'+i+'</link></item>').join('')+'</channel></rss>';
    f.scheduler.complete(task.attempt_id,response(f,task,200,body,{etag:'complete-version'}));
    const transaction=f.scheduler.transaction.bind(f.scheduler);
    f.scheduler.transaction=(fn)=> {
      const result=transaction(fn);
      if(!stopped && Number(f.db.prepare('SELECT discovered FROM sources').get()!.discovered)===100) {
        assert.equal(f.db.isTransaction,false);
        stopped=f.scheduler.close();
      }
      return result;
    };
    await f.scheduler.processAsync();await stopped;
    assert.equal(f.db.prepare('SELECT count(*) n FROM candidates').get()!.n,100);
    assert.equal(f.db.prepare('SELECT polls FROM sources').get()!.polls,0);
    assert.equal(f.db.prepare('SELECT etag FROM sources').get()!.etag,null);
    assert.equal(f.db.prepare('SELECT processing FROM attempt_assignments').get()!.processing,'pending');
    restarted=new Scheduler(f.db,f.dir,f.now);await restarted.processAsync();
    assert.equal(f.db.prepare('SELECT count(*) n FROM candidates').get()!.n,250);
    const source=f.db.prepare('SELECT * FROM sources').get()!;
    assert.equal(source.discovered,250);assert.equal(source.polls,1);assert.equal(source.etag,'complete-version');
    assert.equal(f.db.prepare('SELECT count(*) n FROM requests').get()!.n,1);
    assert.equal(f.db.prepare('SELECT min(discovered) n FROM candidates').get()!.n,finished);
    assert.equal(f.db.prepare('SELECT max(discovered) n FROM candidates').get()!.n,finished);
  }finally{await restarted?.close();await f.scheduler.close();f.close();}
});

test('initial sample remains capped at eight after additional completed history accumulates',()=>{
  const f=fixture();try {
    f.db.exec("UPDATE sources SET next_poll=999999999;UPDATE crawl_tasks SET next_crawl_at=999999999");
    const insert=f.db.prepare("INSERT INTO candidates(url,domain,source,discovered,priority,state) VALUES (?,'bbc.com','x',?,0,?)");
    for(let i=0;i<7;i++) insert.run('https://www.bbc.com/history-'+i,i,'done');
    insert.run('https://www.bbc.com/unknown-first',900000,'pending');
    insert.run('https://www.bbc.com/unknown-second',800000,'pending');
    migrateDurable(f.db);
    const task=f.scheduler.claim('w','seventh-completed').task!;
    assert.equal(task.url,'https://www.bbc.com/unknown-first');
    f.scheduler.complete(task.attempt_id,response(f,task,404));f.scheduler.process();f.advance();
    assert.equal(f.scheduler.claim('w','sample-full').task,null);
    for(let i=7;i<10;i++) insert.run('https://www.bbc.com/history-'+i,i,'failed');
    assert.equal(f.db.prepare("SELECT count(*) n FROM candidates WHERE priority=0 AND state<>'pending'").get()!.n,11);
    assert.equal(new Scheduler(f.db,f.dir,f.now).claim('w','larger-history').task,null);
    assert.equal(f.db.prepare("SELECT state FROM candidates WHERE url='https://www.bbc.com/unknown-second'").get()!.state,'pending');
  }finally{f.close();}
});
