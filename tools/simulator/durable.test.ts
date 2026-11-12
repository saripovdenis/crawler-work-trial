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
    f.scheduler.process();f.scheduler.process();
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
