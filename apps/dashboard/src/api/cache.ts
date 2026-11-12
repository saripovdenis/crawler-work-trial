import { Worker } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { LruCache } from '../../../../packages/core/src/lru.js';
import { coverageQuery, pageCoverage } from '../../../../packages/reconciliation/src/view.js';
import { crawlerOnlyQuery, pageCrawlerOnly } from '../../../../packages/reconciliation/src/crawler-only.js';

type Job={id:number;method:string;args:any;resolve(value:any):void;reject(error:Error):void;timer?:ReturnType<typeof setTimeout>};
type Snapshot={value:any;finishedAt:number;startedAt:number};
export class DashboardCache {
  private worker?:Worker;
  private active?:Job;
  private queue:Job[]=[];
  private sequence=0;
  private closed=false;
  private snapshots=new LruCache<string,Snapshot>(64,64*1024*1024);
  private inflight=new Map<string,Promise<Snapshot>>();
  private counts={hits:0,misses:0,staleHits:0,coalesced:0,errors:0,queries:0,queryMs:0,maxQueryMs:0};
  private methods:{[method:string]:{queries:number;totalMs:number;lastMs:number}}={};
  constructor(readonly directory:string,readonly monitorPath:string) {}
  private start() {
    const worker=new Worker(new URL('./query-worker-bootstrap.mjs',import.meta.url),{
      execArgv:[],workerData:{directory:this.directory,monitorPath:this.monitorPath},resourceLimits:{maxOldGenerationSizeMb:384},
    });
    this.worker=worker;
    worker.on('message',message=> {
      const job=this.active;
      if(!job || job.id!==message.id || this.worker!==worker)return;
      clearTimeout(job.timer);this.active=undefined;
      if(message.error)job.reject(new Error(message.error));
      else {
        this.counts.queries++;this.counts.queryMs+=message.durationMs;
        this.counts.maxQueryMs=Math.max(this.counts.maxQueryMs,message.durationMs);
        const metric=this.methods[job.method]??={queries:0,totalMs:0,lastMs:0};
        metric.queries++;metric.totalMs+=message.durationMs;metric.lastMs=message.durationMs;
        job.resolve({value:message.value,startedAt:message.startedAt,finishedAt:Date.now()});
      }
      this.pump();
    });
    const failed=(error:Error)=> {
      if(this.worker!==worker)return;
      this.worker=undefined;
      if(this.active) {clearTimeout(this.active.timer);this.active.reject(error);this.active=undefined;}
      this.pump();
    };
    worker.on('error',failed);worker.on('exit',code=>failed(new Error(`Dashboard worker exited (${code})`)));
    return worker;
  }
  private pump() {
    if(this.closed || this.active || !this.queue.length)return;
    const worker=this.worker??this.start(),job=this.queue.shift()!;this.active=job;
    job.timer=setTimeout(()=> {
      if(this.active!==job)return;
      this.active=undefined;this.worker=undefined;
      job.reject(new Error('Dashboard query timed out'));
      void worker.terminate();this.pump();
    },120_000);
    worker.postMessage({id:job.id,method:job.method,args:job.args});
  }
  private run(method:string,args:any):Promise<Snapshot> {
    if(this.closed)return Promise.reject(new Error('Dashboard cache closed'));
    if(this.queue.length>=32)return Promise.reject(new Error('Dashboard query queue is full'));
    return new Promise((resolve,reject)=>{this.queue.push({id:++this.sequence,method,args,resolve,reject});this.pump();});
  }
  private refresh(key:string,method:string,args:any) {
    const current=this.inflight.get(key);
    if(current){this.counts.coalesced++;return current;}
    const pending=this.run(method,args).then(snapshot=> {
      this.snapshots.set(key,snapshot,Buffer.byteLength(JSON.stringify(snapshot.value)));
      return snapshot;
    }).catch(error=>{this.counts.errors++;throw error;}).finally(()=>this.inflight.delete(key));
    this.inflight.set(key,pending);return pending;
  }
  private async cached(key:string,method:string,args:any,ttl:number,maxAge:number) {
    const now=Date.now(),saved=this.snapshots.get(key);
    let snapshot:Snapshot,stale=false;
    if(saved && now-saved.startedAt<maxAge) {
      snapshot=saved;
      if(now-saved.finishedAt<ttl)this.counts.hits++;
      else {this.counts.staleHits++;stale=true;void this.refresh(key,method,args).catch(()=>{});}
    } else {this.counts.misses++;snapshot=await this.refresh(key,method,args);}
    if(snapshot.value===null)return null;
    return {...snapshot.value,generatedAt:snapshot.value.generatedAt??snapshot.startedAt,
      cache:{state:stale?'stale':'fresh',ageMs:Math.max(0,Date.now()-(snapshot.value.generatedAt??snapshot.startedAt)),
        computedAt:snapshot.finishedAt,refreshing:this.inflight.has(key),staleLimitMs:maxAge}};
  }
  async coverage(params:URLSearchParams,freshness=false) {
    const q=coverageQuery(params),args={window:q.window,site:q.site,provider:q.provider,freshness};
    const snapshot=await this.cached('coverage:'+JSON.stringify(args),'coverage',args,60_000,300_000);
    return pageCoverage(snapshot,q.matches,q.page);
  }
  async crawlerOnly(params:URLSearchParams) {
    const q=crawlerOnlyQuery(params),args={window:q.window,site:q.site,provider:q.provider};
    const snapshot=await this.cached('crawler-only:'+JSON.stringify(args),'crawlerOnly',args,60_000,300_000);
    return pageCrawlerOnly(snapshot,q.show,q.page);
  }
  async get(method:string,params=new URLSearchParams(),id?:number) {
    const query=new URLSearchParams(params);query.sort();
    const args=method==='detail'?{id}:{query:query.toString()};
    const slow=method==='overview'||method==='charts';
    return this.cached(method+':'+JSON.stringify(args),method,args,slow?30_000:10_000,slow?120_000:60_000);
  }
  async metrics() {
    const load=async(path:string)=>{try{return JSON.parse(await readFile(resolve(this.directory,path),'utf8'));}catch{return null;}};
    const [crawler,archives]=await Promise.all([load('cache-metrics.json'),load('receipts/archive-cache-metrics.json')]);
    return {generatedAt:Date.now(),dashboard:{...this.counts,methods:this.methods,entries:this.snapshots.size,
      bytes:this.snapshots.byteSize,evictions:this.snapshots.evictions,refreshes:this.inflight.size,queued:this.queue.length},crawler,archives};
  }
  async close() {
    this.closed=true;
    for(const job of this.queue)job.reject(new Error('Dashboard shutting down'));
    this.queue=[];
    if(this.active){clearTimeout(this.active.timer);this.active.reject(new Error('Dashboard shutting down'));this.active=undefined;}
    const worker=this.worker;this.worker=undefined;
    if(worker)await worker.terminate();
  }
}
