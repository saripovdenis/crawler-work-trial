import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { db, dataDir, summary } from '../../../../packages/db/src/store.js';
import { sites } from '../../../../config/sites.js';
import { acquireLock } from '../../../../packages/protocol/src/files.js';
import { Scheduler } from './durable.js';
import { schedulerServer } from './server.js';
// Same lock as the legacy loop: never start both against this database.
const release=acquireLock(resolve(dataDir,'crawler.pid'));
const now=Date.now();
db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES ('started',?)").run(new Date(now).toISOString());
for(const site of sites) {
  db.prepare('INSERT OR IGNORE INTO sites(domain,started) VALUES (?,?)').run(site.domain,now);
  db.prepare("INSERT OR IGNORE INTO sources(url,domain,kind) VALUES (?,?,'html')").run(`https://www.${site.domain}/`,site.domain);
}
const scheduler=new Scheduler(db,dataDir);
const server=schedulerServer(scheduler);
const report=()=> {
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('heartbeat',?)").run(new Date().toISOString());
  writeFileSync(resolve(dataDir,'status.json'),JSON.stringify(summary(),null,2));
};
const processing=setInterval(()=> {try {scheduler.recover();}catch(e){console.error('scheduler recovery failed',e);}},1000);
const heartbeat=setInterval(report,30_000);
report();
server.listen(Number(process.env.SCHEDULER_PORT||4319),'127.0.0.1',()=>console.log('Scheduler listening on loopback',server.address()));
let stopping=false;
for(const event of ['SIGINT','SIGTERM']) process.on(event,()=> {
  if(stopping)return;stopping=true;clearInterval(processing);clearInterval(heartbeat);
  server.close(()=> {report();db.close();release();});
});
