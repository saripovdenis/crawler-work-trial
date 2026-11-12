import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { db, dataDir, summary } from '../../../../packages/db/src/store.js';
import { discoverySeeds } from '../../../../config/discovery.js';
import { sites } from '../../../../config/sites.js';
import { acquireLock, atomicWrite } from '../../../../packages/protocol/src/files.js';
import { Scheduler } from './durable.js';
import { importAudits } from '../../../../packages/reconciliation/src/audits.js';
import { schedulerServer } from './server.js';
// Same lock as the legacy loop: never start both against this database.
const release=acquireLock(resolve(dataDir,'crawler.pid'));
const now=Date.now();
db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES ('started',?)").run(new Date(now).toISOString());
for(const site of sites) {
  db.prepare('INSERT OR IGNORE INTO sites(domain,started) VALUES (?,?)').run(site.domain,now);
  db.prepare("INSERT OR IGNORE INTO sources(url,domain,kind) VALUES (?,?,'html')").run(`https://www.${site.domain}/`,site.domain);
}
for(const seed of discoverySeeds) db.prepare('INSERT OR IGNORE INTO sources(url,domain,kind) VALUES (?,?,?)').run(seed.url,seed.domain,seed.kind);
const scheduler=new Scheduler(db,dataDir);
// Revisit failed archives once after a code restart; no network request or charge.
db.prepare("UPDATE attempt_assignments SET process_after=0 WHERE processing='pending' AND process_error IS NOT NULL").run();
const server=schedulerServer(scheduler);
const report=()=> {
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('heartbeat',?)").run(new Date().toISOString());
  writeFileSync(resolve(dataDir,'status.json'),JSON.stringify(summary(),null,2));
  atomicWrite(resolve(dataDir,'cache-metrics.json'),JSON.stringify(scheduler.cacheMetrics()));
};
const processing=setInterval(()=> {try {scheduler.recover(false);void scheduler.processAsync().catch(e=>console.error('archive processing failed',e));}catch(e){console.error('scheduler recovery failed',e);}},1000);
const quality=setInterval(()=> {try {scheduler.refreshSourceQuality();}catch(e){console.error('source quality refresh failed',e);}},60_000);
const heartbeat=setInterval(report,30_000);
const audits=setInterval(()=> {try {
  if(process.env.RECONCILER_DB)importAudits(db,resolve(process.env.RECONCILER_DB));
}catch(e){console.error('audit import failed',String(e));}},30_000);
report();
server.listen(Number(process.env.SCHEDULER_PORT||4319),'127.0.0.1',()=>console.log('Scheduler listening on loopback',server.address()));
let stopping=false;
for(const event of ['SIGINT','SIGTERM']) process.on(event,()=> {
  if(stopping)return;stopping=true;clearInterval(processing);clearInterval(quality);clearInterval(heartbeat);clearInterval(audits);
  server.close(()=> {void scheduler.close().finally(()=>{report();db.close();release();});});
});
