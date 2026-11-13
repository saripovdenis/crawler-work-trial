import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { setTimeout as sleep } from 'node:timers/promises';
import { atomicWrite, acquireLock } from '../../../../packages/protocol/src/files.js';
import { DISPATCH_MS, MAX_RESPONSE_BYTES, type Claim, type Assignment, type Completion } from '../../../../packages/protocol/src/index.js';
import { elapsedMs, timingLog } from '../../../../packages/protocol/src/timing.js';
import { fetchResponse } from './transports/transport.js';
import { createBodyStore, type BodyStore } from '../../../../packages/protocol/src/body-store.js';
import { ArchiveMirror } from '../../../../packages/protocol/src/archive-mirror.js';
const stores=new Map<string,BodyStore>();
const archiveStore=(directory:string)=> {
  let store=stores.get(directory);
  if(!store) {store=createBodyStore(directory);stores.set(directory,store);}
  return store;
};
type Receipt={claim_id:string; task?:Assignment; dispatched?:boolean; completion?:Completion};
export async function execute(task: Assignment, directory: string): Promise<Completion> {
  const result:Completion={lease_token:task.lease_token,started_at:null,finished_at:new Date().toISOString(),status:null,headers:{},body_hash:null,response_ref:null,bytes:0,error:null};
  const started=performance.now(),durations:Record<string,number>={};
  let phase='dispatch',phaseStarted=started,reused:boolean|undefined;
  const next=(name:string)=> {durations[phase+'_ms']=elapsedMs(phaseStarted);phase=name;phaseStarted=performance.now();};
  try {
    if(Date.now()>Date.parse(task.start_by)) throw new Error('Dispatch deadline expired');
    if(task.timeout_ms!==20_000 || task.max_response_bytes!==MAX_RESPONSE_BYTES || !['node','chrome136'].includes(task.transport)) throw new Error('Unsupported assignment limits');
    result.started_at=new Date().toISOString();
    next('response_wait');
    const response=await fetchResponse(task.url,task.headers,AbortSignal.timeout(task.timeout_ms),task);
    next('body_read');
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
    result.fetch_finished_at=new Date().toISOString();
    next('decode_hash');
    let bytes=Buffer.concat(chunks);
    if(bytes[0]===0x1f&&bytes[1]===0x8b) bytes=gunzipSync(bytes,{maxOutputLength:task.max_response_bytes});
    const hash=createHash('sha256').update(bytes).digest('hex');
    next('archive_store');
    const stored=archiveStore(directory).store(bytes,hash);
    reused=stored.reused;
    const {ref}=stored;
    result.body_hash=hash;result.response_ref=ref;result.bytes=bytes.length;
  } catch(e) {result.error=String(e).slice(0,4096);}
  result.finished_at=new Date().toISOString();
  durations[phase+'_ms']=elapsedMs(phaseStarted);
  timingLog('fetch', {attempt_id:task.attempt_id,task_id:task.task_id,domain:task.domain,purpose:task.purpose,
    transport:task.transport,status:result.status,failed:result.error!==null,failed_phase:result.error?phase:null,
    dispatch_wait_ms:result.started_at?Date.parse(result.started_at)-(Date.parse(task.start_by)-DISPATCH_MS):null,
    response_wait_scope:task.transport==='chrome136'?'python_startup_and_full_response':'connection_and_response_headers',
    ...durations,total_ms:elapsedMs(started),bytes:result.bytes,archive_reused:reused});
  return result;
}
export async function runWorker(directory: string, schedulerUrl: string, concurrency=4, signal: AbortSignal) {
  const base=new URL(schedulerUrl);
  if(base.hostname!=='127.0.0.1'||base.protocol!=='http:'||base.username||base.password) throw new Error('Scheduler must be loopback HTTP');
  if(!Number.isInteger(concurrency)||concurrency<1||concurrency>20) throw new Error('Invalid concurrency');
  mkdirSync(resolve(directory,'receipts'),{recursive:true});
  const release=acquireLock(resolve(directory,'receipts','fetch-worker.pid'));
  const mirror=process.env.ARCHIVE_MIRROR==='1' ? new ArchiveMirror(directory) : undefined;
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
  function saveReceipt(path:string,receipt:Receipt,phase:string) {
    const started=performance.now();
    let written=false;
    try {atomicWrite(path,JSON.stringify(receipt));written=true;}
    finally {timingLog('receipt_write',{attempt_id:receipt.task?.attempt_id,claim_id:receipt.claim_id,phase,written,durable_write_ms:elapsedMs(started)});}
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
        saveReceipt(path,receipt,'before_claim');
        if(!receipt.task) {
          const started=performance.now();
          let result!:Claim;
          try {result=await post('/internal/claims',{worker_id,claim_id:receipt.claim_id});}
          finally {
            if(!result || result.task || elapsedMs(started)>=1000) timingLog('claim_client',{claim_id:receipt.claim_id,attempt_id:result?.task?.attempt_id,
              roundtrip_ms:elapsedMs(started),assigned:!!result?.task,failed:!result});
          }
          if(!result.task) {unlinkSync(path);await sleep(result.retry_after_ms||1000);continue;}
          receipt.task=result.task;saveReceipt(path,receipt,'assigned');
        }
        if(!receipt.completion) {
          if(receipt.dispatched) {
            // A previous process may have sent this request. Never send it again.
            // Wait until the scheduler's safety horizon before acknowledging unknown outcome.
            if(Date.now()<Date.parse(receipt.task.lease_until)) {await sleep(1000);continue;}
            receipt.completion={lease_token:receipt.task.lease_token,started_at:null,finished_at:new Date().toISOString(),status:null,headers:{},body_hash:null,response_ref:null,bytes:0,error:'Worker restarted; outcome unknown'};
          } else {
            receipt.dispatched=true;saveReceipt(path,receipt,'before_dispatch');
            receipt.completion=await execute(receipt.task,directory);
          }
          saveReceipt(path,receipt,'completed');
        }
        // Upload retries run independently and never hold a publisher slot.
        if(receipt.completion.body_hash) {
          try {mirror?.enqueue(receipt.completion.body_hash);}
          catch(error) {console.error('Could not enqueue optional archive mirror:',String(error));}
        }
        const started=performance.now();
        let acknowledged=false;
        try {await post(`/internal/attempts/${receipt.task.attempt_id}/complete`,receipt.completion);acknowledged=true;}
        finally {timingLog('complete_client',{attempt_id:receipt.task.attempt_id,acknowledged,roundtrip_ms:elapsedMs(started)});}
        unlinkSync(path);
      } catch(e) {console.error('Worker will retry receipt:',String(e));await sleep(1000);}
    }
  }));} finally {await mirror?.close();clearInterval(metricsTimer);report();release();}
}
