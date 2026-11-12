import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { setTimeout as sleep } from 'node:timers/promises';
import { atomicWrite, acquireLock } from '../../../../packages/protocol/src/files.js';
import { MAX_RESPONSE_BYTES, type Claim, type Assignment, type Completion } from '../../../../packages/protocol/src/index.js';
import { fetchResponse } from './transports/transport.js';
import { ArchiveStore } from '../../../../packages/protocol/src/archives.js';
const stores=new Map<string,ArchiveStore>();
const archiveStore=(directory:string)=> {
  let store=stores.get(directory);
  if(!store) {store=new ArchiveStore(directory);stores.set(directory,store);}
  return store;
};
type Receipt={claim_id:string; task?:Assignment; dispatched?:boolean; completion?:Completion};
export async function execute(task: Assignment, directory: string): Promise<Completion> {
  const result:Completion={lease_token:task.lease_token,started_at:null,finished_at:new Date().toISOString(),status:null,headers:{},body_hash:null,response_ref:null,bytes:0,error:null};
  try {
    if(Date.now()>Date.parse(task.start_by)) throw new Error('Dispatch deadline expired');
    if(task.timeout_ms!==20_000 || task.max_response_bytes!==MAX_RESPONSE_BYTES || !['node','chrome136'].includes(task.transport)) throw new Error('Unsupported assignment limits');
    result.started_at=new Date().toISOString();
    const response=await fetchResponse(task.url,task.headers,AbortSignal.timeout(task.timeout_ms),task);
    result.status=response.status;result.headers=Object.fromEntries(response.headers);
    const chunks:Uint8Array[]=[];let length=0;
    if(response.body) {
      const reader=response.body.getReader();
      while(true) {
        const {value,done}=await reader.read();if(done)break;
        length+=value.length;if(length>task.max_response_bytes){await reader.cancel();throw new Error('Response exceeds 5 MiB');}
        chunks.push(value);
      }
    }
    let bytes=Buffer.concat(chunks);
    if(bytes[0]===0x1f&&bytes[1]===0x8b) bytes=gunzipSync(bytes,{maxOutputLength:task.max_response_bytes});
    const hash=createHash('sha256').update(bytes).digest('hex');
    const {ref}=archiveStore(directory).store(bytes,hash);
    result.body_hash=hash;result.response_ref=ref;result.bytes=bytes.length;
  } catch(e) {result.error=String(e).slice(0,4096);}
  result.finished_at=new Date().toISOString();return result;
}
export async function runWorker(directory: string, schedulerUrl: string, concurrency=4, signal: AbortSignal) {
  const base=new URL(schedulerUrl);
  if(base.hostname!=='127.0.0.1'||base.protocol!=='http:'||base.username||base.password) throw new Error('Scheduler must be loopback HTTP');
  if(!Number.isInteger(concurrency)||concurrency<1||concurrency>20) throw new Error('Invalid concurrency');
  mkdirSync(resolve(directory,'receipts'),{recursive:true});
  const release=acquireLock(resolve(directory,'receipts','fetch-worker.pid'));
  const store=archiveStore(directory),metricsPath=resolve(directory,'receipts','archive-cache-metrics.json');
  try {
    const previous=JSON.parse(readFileSync(metricsPath,'utf8'));
    for(const key of Object.keys(store.metrics) as (keyof typeof store.metrics)[])
      if(Number.isSafeInteger(previous[key]) && previous[key]>=0)store.metrics[key]=previous[key];
  }catch {}
  const report=()=>{try{atomicWrite(metricsPath,JSON.stringify({generatedAt:Date.now(),...store.metrics}));}catch(error){console.error('Archive metrics:',String(error));}};
  const metricsTimer=setInterval(report,30_000);metricsTimer.unref();
  const identity=resolve(directory,'receipts','worker-id');
  if(!existsSync(identity)) atomicWrite(identity,randomUUID());
  const worker_id=readFileSync(identity,'utf8');
  async function post(path:string,value:unknown) {
    const response=await fetch(new URL(path,base),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value),signal:AbortSignal.timeout(5000),redirect:'error'});
    if(!response.ok) throw new Error(`Scheduler HTTP ${response.status}`);
    return response.json();
  }
  // Recovery scans every persisted slot, even if concurrency was reduced on restart.
  const {readdirSync}=await import('node:fs');
  const slots=new Set([...Array.from({length:concurrency},(_,i)=>String(i)),...readdirSync(resolve(directory,'receipts')).filter(x=>/^\d+\.json$/.test(x)).map(x=>x.slice(0,-5))]);
  try {await Promise.all([...slots].map(async slot=> {
    const path=resolve(directory,'receipts',slot+'.json');
    const recoveryOnly=Number(slot)>=concurrency;
    while(!signal.aborted) {
      if(recoveryOnly&&!existsSync(path))return;
      try {
        let receipt:Receipt=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{claim_id:randomUUID()};
        atomicWrite(path,JSON.stringify(receipt));
        if(!receipt.task) {
          const result:Claim=await post('/internal/claims',{worker_id,claim_id:receipt.claim_id});
          if(!result.task) {unlinkSync(path);await sleep(result.retry_after_ms||1000);continue;}
          receipt.task=result.task;atomicWrite(path,JSON.stringify(receipt));
        }
        if(!receipt.completion) {
          if(receipt.dispatched) {
            // A previous process may have sent this request. Never send it again.
            // Wait until the scheduler's safety horizon before acknowledging unknown outcome.
            if(Date.now()<Date.parse(receipt.task.lease_until)) {await sleep(1000);continue;}
            receipt.completion={lease_token:receipt.task.lease_token,started_at:null,finished_at:new Date().toISOString(),status:null,headers:{},body_hash:null,response_ref:null,bytes:0,error:'Worker restarted; outcome unknown'};
          } else {
            receipt.dispatched=true;atomicWrite(path,JSON.stringify(receipt));
            receipt.completion=await execute(receipt.task,directory);
          }
          atomicWrite(path,JSON.stringify(receipt));
        }
        await post(`/internal/attempts/${receipt.task.attempt_id}/complete`,receipt.completion);
        unlinkSync(path);
      } catch(e) {console.error('Worker will retry receipt:',String(e));await sleep(1000);}
    }
  }));} finally {clearInterval(metricsTimer);report();release();}
}
