import { DatabaseSync, backup } from 'node:sqlite';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve,join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';
const root=process.cwd(),dir=mkdtempSync(join(tmpdir(),'durable-smoke-'));
const source=new DatabaseSync(resolve(process.argv[2]),{readOnly:true});await backup(source,join(dir,'crawler.sqlite'));source.close();
const db=new DatabaseSync(join(dir,'crawler.sqlite'));db.exec('PRAGMA busy_timeout=5000');
const starts=db.prepare('SELECT domain,started FROM sites ORDER BY domain').all();
const before=db.prepare('SELECT count(*) n,max(id) id FROM requests').get();
const socket=createServer();await new Promise(ok=>socket.listen(0,'127.0.0.1',ok));const port=socket.address().port;await new Promise(ok=>socket.close(ok));
const children=new Set();
function start(entry,preload){
 const c=spawn(process.execPath,[...(preload?['--import',resolve('tools/simulator/worker-preload.mjs')]:[]),'--import','tsx',entry],{cwd:root,env:{...process.env,CRAWLER_DATA_DIR:dir,SCHEDULER_PORT:String(port),SCHEDULER_URL:`http://127.0.0.1:${port}`,CRAWLER_PYTHON:resolve('tools/simulator/fake-python.cjs')},stdio:['ignore','pipe','pipe']});
 c.output='';c.stdout.on('data',x=>c.output+=x);c.stderr.on('data',x=>c.output+=x);c.done=new Promise((ok,fail)=>{c.on('error',fail);c.on('exit',code=>ok(code));});children.add(c);return c;
}
async function stop(c,signal='SIGTERM'){c.kill(signal);const timer=setTimeout(()=>c.kill('SIGKILL'),30000);const status=await c.done;clearTimeout(timer);children.delete(c);if(signal==='SIGTERM')assert.equal(status,0,c.output);}
async function until(fn){for(let i=0;i<200;i++){if(fn())return;for(const c of children)if(c.exitCode!==null)throw new Error(c.output);await sleep(100);}throw new Error('Smoke timeout: '+[...children].map(c=>c.output).join('\n'));}
try{
 let coordinator=start('services/crawler/src/scheduler/index.ts');await until(()=>coordinator.output.includes('listening'));
 let worker=start('services/crawler/src/fetcher/index.ts',true);
 await until(()=>db.prepare("SELECT count(*) n FROM attempt_assignments WHERE processing='done' AND request_id>?").get(before.id).n>0);
 await stop(worker);await stop(coordinator);
 assert.ok(!existsSync(join(dir,'crawler.pid')));assert.ok(!existsSync(join(dir,'receipts','fetch-worker.pid')));
 const records=db.prepare('SELECT count(*) n FROM attempt_assignments').get().n;
 coordinator=start('services/crawler/src/scheduler/index.ts');await until(()=>coordinator.output.includes('listening'));
 worker=start('services/crawler/src/fetcher/index.ts',true);
 await until(()=>db.prepare('SELECT count(*) n FROM attempt_assignments').get().n>records);
 await stop(worker);await stop(coordinator);
 assert.deepEqual(db.prepare('SELECT domain,started FROM sites ORDER BY domain').all(),starts);
 assert.equal(db.prepare('SELECT count(*) n FROM requests WHERE id<=?').get(before.id).n,before.n);
 assert.equal(db.prepare('SELECT count(*) n FROM (SELECT domain,count(*) n FROM attempt_assignments WHERE terminal IS NULL GROUP BY domain HAVING n>1)').get().n,0);
 console.log('Two-process startup/restart passed. Old ledger and site startup times preserved. Attempts:',db.prepare('SELECT count(*) n FROM attempt_assignments').get().n);
}finally{for(const c of children){c.kill('SIGKILL');await c.done;}db.close();rmSync(dir,{recursive:true,force:true});}
