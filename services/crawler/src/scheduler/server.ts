import { createServer } from 'node:http';
import { Scheduler, ContractError } from './durable.js';
import { elapsedMs, timingLog } from '../../../../packages/protocol/src/timing.js';
export function schedulerServer(scheduler: Scheduler) {
  const server=createServer(async(req,res)=> {
    res.setHeader('Content-Type','application/json');
    res.setHeader('Cache-Control','no-store');
    const started=performance.now();
    let details:Record<string,unknown>|undefined;
    try {
      if(req.method==='GET'&&req.url==='/internal/health') {res.end('{"ok":true}');return;}
      if(req.method!=='POST') throw new ContractError('Method not allowed',405);
      let body='';
      for await(const chunk of req) { body+=chunk; if(Buffer.byteLength(body)>65536) throw new ContractError('Body too large',413); }
      let value:any;try {value=JSON.parse(body);} catch {throw new ContractError('Invalid JSON');}
      if(!value||typeof value!=='object'||Array.isArray(value)) throw new ContractError('Expected object');
      let result:unknown;
      const handlerStarted=performance.now();
      if(req.url==='/internal/claims') {
        details={operation:'claim',claim_id:value.claim_id};
        const claim=scheduler.claim(value.worker_id,value.claim_id);
        result=claim;
        Object.assign(details,{attempt_id:claim.task?.attempt_id,assigned:!!claim.task});
      }
      else {
        const id=req.url?.match(/^\/internal\/attempts\/([\w-]+)\/complete$/)?.[1];
        if(!id) throw new ContractError('Not found',404);
        details={operation:'complete',attempt_id:id};
        result=scheduler.complete(id,value);
        setImmediate(()=>void scheduler.processAsync().catch(error=>console.error('archive processing failed',error)));
      }
      if(details)details.handler_ms=elapsedMs(handlerStarted);
      res.end(JSON.stringify(result));
    } catch(e) {
      const status=e instanceof ContractError?e.status:500;
      if(status===500) console.error('scheduler request failed',e);
      res.writeHead(status);res.end(JSON.stringify({error:status===500?'Internal error':String(e)}));
    } finally {
      // Fast empty claims are ordinary idle polling; do not flood the log.
      if(details && (details.operation!=='claim' || details.assigned || elapsedMs(started)>=1000 || res.statusCode>=400))
        timingLog('scheduler',{...details,total_ms:elapsedMs(started),status:res.statusCode});
    }
  });
  server.requestTimeout=10_000;server.headersTimeout=5000;
  return server;
}
