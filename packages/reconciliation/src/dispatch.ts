import type { DatabaseSync } from '../../pg/src/sync.js';

type Row = Record<string, any>;
export function dispatchSummary(db: DatabaseSync, now: number, site = '') {
  const result = {windowStart:now-3600000,windowEnd:now,available:false,attempts:0,reportedStarts:0,unsent:0,deadlineFailures:0,leaseExpiries:0,p50Ms:null as number|null,p95Ms:null as number|null,maxMs:null as number|null,byTransport:[] as {transport:string;attempts:number;deadlineFailures:number}[]};
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='attempt_assignments'").get()) return result;
  result.available=true;
  const rows=db.prepare(`SELECT r.started,a.start_by,a.terminal,a.assignment,a.completion FROM attempt_assignments a JOIN requests r ON r.id=a.request_id
    WHERE r.started>=? AND r.started<? AND (?='' OR r.domain=?)`).all(result.windowStart,now,site,site) as Row[];
  const delays:number[]=[],transports=new Map<string,{transport:string;attempts:number;deadlineFailures:number}>();
  for(const r of rows) {
    result.attempts++;
    let assignment:Row={},completion:Row={};
    try{assignment=JSON.parse(r.assignment);completion=JSON.parse(r.completion||'{}');}catch{}
    const transport=String(assignment.transport||'unknown');
    const group=transports.get(transport)||{transport,attempts:0,deadlineFailures:0};group.attempts++;transports.set(transport,group);
    if(r.terminal==='expired')result.leaseExpiries++;
    if(/dispatch deadline expired/i.test(completion.error||'')){result.deadlineFailures++;group.deadlineFailures++;}
    const start=Date.parse(completion.started_at);
    if(Number.isFinite(start)&&start>=r.started){delays.push(start-r.started);result.reportedStarts++;}
    else if(r.completion)result.unsent++;
  }
  delays.sort((a,b)=>a-b);
  const percentile=(p:number)=>delays.length?delays[Math.ceil(p*delays.length)-1]!:null;
  result.p50Ms=percentile(.5);result.p95Ms=percentile(.95);result.maxMs=delays.at(-1)??null;
  result.byTransport=[...transports.values()];
  return result;
}
