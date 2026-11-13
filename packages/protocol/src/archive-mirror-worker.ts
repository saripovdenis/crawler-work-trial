import { parentPort, workerData } from 'node:worker_threads';
import { readdirSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createBodyStore } from './body-store.js';
import { StorageClient } from './storage-client.js';
import { atomicWrite } from './files.js';

const directory:string=workerData.directory,root=resolve(directory,'receipts','archive-mirror');
const bodies=createBodyStore(directory),client=new StorageClient();
const metricsPath=resolve(directory,'receipts','archive-mirror-metrics.json');
let metrics={startedAt:Date.now(),uploaded:0,uploadBytes:0,errors:0,lastError:null as string|null,
  lastUploadedAt:null as number|null,lastUploadMs:0,totalUploadMs:0,maxUploadMs:0,pending:0,oldestPendingAt:null as number|null};
try {metrics={...metrics,...JSON.parse(readFileSync(metricsPath,'utf8'))};}catch {}
// The per-object markers survive a crash between PUT and metrics publication.
metrics.uploaded=readdirSync(resolve(root,'uploaded')).filter(name=>/^[a-f0-9]{64}\.json$/.test(name)).length;
let running=false,retryAt=0,failures=0;
function report() {atomicWrite(metricsPath,JSON.stringify({...metrics,generatedAt:Date.now(),retryAt}));}
async function pump() {
  if(running)return;running=true;
  try {
    const names=readdirSync(resolve(root,'pending')).filter(name=>/^[a-f0-9]{64}\.json$/.test(name));
    const pending=names.map(name=>({name,...JSON.parse(readFileSync(resolve(root,'pending',name),'utf8'))}))
      .sort((a,b)=>a.queuedAt-b.queuedAt);
    metrics.pending=pending.length;metrics.oldestPendingAt=pending[0]?.queuedAt??null;
    report();
    if(Date.now()<retryAt)return;
    for(const item of pending.slice(0,20)) {
      const hash=item.name.slice(0,-5),done=resolve(root,'uploaded',item.name);
      if(!existsSync(done)) {
        const compressed=bodies.readCompressed(hash),start=performance.now();
        await client.put(hash,compressed);
        const duration=performance.now()-start,uploadedAt=Date.now();
        atomicWrite(done,JSON.stringify({hash,queuedAt:item.queuedAt,uploadedAt,bytes:compressed.length,uploadMs:duration}));
        metrics.uploaded++;metrics.uploadBytes+=compressed.length;metrics.lastUploadMs=duration;
        metrics.totalUploadMs+=duration;metrics.maxUploadMs=Math.max(metrics.maxUploadMs,duration);
        metrics.lastUploadedAt=uploadedAt;
      }
      unlinkSync(resolve(root,'pending',item.name));metrics.pending--;
      failures=0;retryAt=0;metrics.lastError=null;
    }
  } catch(error) {
    metrics.errors++;metrics.lastError=error instanceof Error?error.message:String(error);
    retryAt=Date.now()+Math.min(60000,1000*2**Math.min(++failures,6));
  } finally {if(metrics.pending===0)metrics.oldestPendingAt=null;running=false;report();}
}
parentPort!.on('message',()=>void pump());
setInterval(()=>void pump(),2000);
void pump();
