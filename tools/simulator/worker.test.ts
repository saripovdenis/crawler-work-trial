import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { execute, runWorker } from '../../services/crawler/src/fetcher/remote-worker.js';
import type { Assignment } from '../../packages/protocol/src/index.js';
const task=(url:string):Assignment=>({task_id:'1',attempt_id:'attempt',lease_token:'token',domain:'bbc.com',url,purpose:'discovery',transport:'node',headers:{},timeout_ms:20000,max_response_bytes:5242880,start_by:new Date(Date.now()+2000).toISOString(),lease_until:new Date(Date.now()+60000).toISOString()});
async function listen(server:ReturnType<typeof createServer>) {await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok));return `http://127.0.0.1:${(server.address() as any).port}`;}
async function close(server:ReturnType<typeof createServer>) {server.closeAllConnections();await new Promise<void>(ok=>server.close(()=>ok()));}
async function until(fn:()=>boolean){for(let i=0;i<100;i++){if(fn())return;await sleep(50);}throw new Error('Timed out');}
test('worker fetches exactly one hop, enforces body cap and deadline, archives even empty responses',async()=> {
  const dir=mkdtempSync(join(tmpdir(),'worker-'));let requests=0;
  const server=createServer((req,res)=>{requests++;if(req.url==='/redirect'){res.writeHead(302,{Location:'/must-not-follow'});res.end();}
    else if(req.url==='/big')res.end(Buffer.alloc(6*1024*1024));else res.end('fixture');});
  const base=await listen(server);
  try {
    const result=await execute(task(base+'/redirect'),dir);
    assert.equal(result.status,302);assert.equal(result.bytes,0);assert.equal(result.error,null);assert.ok(existsSync(join(dir,result.response_ref!)));assert.equal(requests,1);
    assert.match((await execute(task(base+'/big'),dir)).error!,/5 MiB/);assert.equal(requests,2);
    const expired=task(base);expired.start_by=new Date(0).toISOString();
    assert.match((await execute(expired,dir)).error!,/deadline/);assert.equal(requests,2);
  }finally{await close(server);rmSync(dir,{recursive:true,force:true});}
});
test('lost claim reply and completion ACK survive worker restart without refetching',async()=> {
  const dir=mkdtempSync(join(tmpdir(),'receipts-'));let fetched=0,claimed=0,completed=0;const ids:string[]=[];
  const upstream=createServer((_req,res)=>{fetched++;res.end('fixture');});const origin=await listen(upstream);
  let assignment:Assignment|undefined;
  const coordinator=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;const value=JSON.parse(body);
    if(req.url==='/internal/claims'){
      ids.push(value.claim_id);claimed++;
      if(completed){res.end(JSON.stringify({task:null,retry_after_ms:50}));return;}
      assignment??=task(origin);
      if(claimed===1){res.destroy();return;}
      res.end(JSON.stringify({task:assignment}));
    }else{
      completed++;
      assert.ok(existsSync(join(dir,value.response_ref))); // archive precedes report
      if(completed===1){res.destroy();return;}
      res.end('{"outcome":"completed"}');
    }
  });const base=await listen(coordinator);
  let control=new AbortController();let running=runWorker(dir,base,1,control.signal);
  try {
    await until(()=>completed===1);control.abort();await running;
    const receipt=JSON.parse(readFileSync(join(dir,'receipts/0.json'),'utf8'));assert.ok(receipt.completion);
    control=new AbortController();running=runWorker(dir,base,1,control.signal);
    await until(()=>completed>=2);control.abort();await running;
    assert.equal(ids[0],ids[1]);assert.equal(fetched,1);
    assert.equal(readdirSync(join(dir,'receipts')).some(x=>x.endsWith('.json')),false);
  }finally{control.abort();await running;await close(coordinator);await close(upstream);rmSync(dir,{recursive:true,force:true});}
});

test('a dispatched receipt after a crash is reported unknown, never fetched again',async()=>{
  const {mkdirSync}=await import('node:fs');
  const dir=mkdtempSync(join(tmpdir(),'unknown-receipt-'));mkdirSync(join(dir,'receipts'));
  let attempts=0,reports=0;
  const upstream=createServer((_req,res)=>{attempts++;res.end('unexpected');});const origin=await listen(upstream);
  const value=task(origin);value.lease_until=new Date(0).toISOString();
  writeFileSync(join(dir,'receipts/0.json'),JSON.stringify({claim_id:'old',task:value,dispatched:true}));
  const coordinator=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    if(req.url!.endsWith('/complete')){reports++;assert.match(JSON.parse(body).error,/outcome unknown/);res.end('{"outcome":"expired"}');}
    else res.end('{"task":null,"retry_after_ms":50}');
  });const base=await listen(coordinator);const control=new AbortController();const running=runWorker(dir,base,1,control.signal);
  try{await until(()=>reports>0);control.abort();await running;assert.equal(attempts,0);}
  finally{control.abort();await running;await close(coordinator);await close(upstream);rmSync(dir,{recursive:true,force:true});}
});
test('worker enforces its 20-second request timeout against a hanging simulator',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'timeout-'));let requests=0;
  const server=createServer(()=>{requests++;});const origin=await listen(server);
  try{const start=Date.now();const value=await execute(task(origin),dir);assert.ok(value.error);assert.equal(requests,1);assert.ok(Date.now()-start<26000);}
  finally{await close(server);rmSync(dir,{recursive:true,force:true});}
});
