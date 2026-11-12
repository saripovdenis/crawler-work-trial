import { DatabaseSync, backup } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { Scheduler } from '../../services/crawler/src/scheduler/durable.ts';
import { Observatory } from '../../apps/dashboard/src/metrics/observability.ts';
if(!process.argv[2])throw new Error('Pass a database snapshot path');
const dir=mkdtempSync(join(tmpdir(),'shadow-'));const input=new DatabaseSync(resolve(process.argv[2]),{readOnly:true});
await backup(input,join(dir,'crawler.sqlite'));input.close();
const db=new DatabaseSync(join(dir,'crawler.sqlite'));const fixed=Date.now();const real=Date.now;Date.now=()=>fixed;
try{
  const initial=new Observatory(dir);const before=initial.overview();initial.db.close();
  const oldSchema=db.prepare("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all();
  const start=performance.now();const s=new Scheduler(db,dir);new Scheduler(db,dir);
  console.log('Migration ms:',Math.round(performance.now()-start));
  for(const row of oldSchema)assert.equal(db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(row.name).sql,row.sql);
  assert.equal(db.prepare("SELECT count(*) n FROM sources s LEFT JOIN crawl_tasks t ON t.url=s.url AND t.purpose='discovery' WHERE t.next_crawl_at IS NOT s.next_poll").get().n,0);
  assert.equal(db.prepare("SELECT count(*) n FROM candidates c LEFT JOIN crawl_tasks t ON t.url=c.url AND t.purpose='article' WHERE c.state='pending' AND t.next_crawl_at IS NOT c.next_attempt").get().n,0);
  const after=new Observatory(dir);assert.deepEqual(after.overview(),before);after.db.close();
  const runs=[];for(let i=0;i<30;i++){const at=performance.now();const claim=s.claim('shadow','shadow-'+i);runs.push({ms:Math.round(performance.now()-at),domain:claim.task?.domain});}
  const domains=runs.map(x=>x.domain).filter(Boolean);assert.equal(new Set(domains).size,domains.length);
  console.log('Shadow claims:',JSON.stringify(runs));console.log('Preserved all existing schema and due times; dashboard parity passed; tasks:',db.prepare('SELECT count(*) n FROM crawl_tasks').get().n);
}finally{Date.now=real;db.close();rmSync(dir,{recursive:true,force:true});}
