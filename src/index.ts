import { writeFileSync, readFileSync, unlinkSync, openSync, closeSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sites } from './sites.js';
import { db, dataDir, run, summary } from './store.js';
import { worker, log } from './worker.js';
import { controller, pause, signal } from './http.js';

const lock = resolve(dataDir, 'crawler.pid');
try {
  const pid = Number(readFileSync(lock, 'utf8'));
  try { process.kill(pid, 0); console.error(`Crawler already running (PID ${pid})`); process.exit(1); }
  catch (error: any) { if (error.code !== 'ESRCH') throw error; unlinkSync(lock); }
} catch (error: any) { if (error.code !== 'ENOENT') throw error; }
const fd = openSync(lock, 'wx');
writeFileSync(fd, String(process.pid)); closeSync(fd);
for (const name of ['articles.jsonl', 'new-articles.jsonl']) appendFileSync(resolve(dataDir, name), '');
const now = Date.now();
run("INSERT OR IGNORE INTO meta(key,value) VALUES ('started',?)", new Date(now).toISOString());
for (const site of sites) {
  run('INSERT OR IGNORE INTO sites(domain,started) VALUES (?,?)', site.domain, now);
  run('INSERT OR IGNORE INTO sources(url,domain,kind) VALUES (?,?,?)', `https://www.${site.domain}/`, site.domain, 'html');
}
const report = () => {
  run("INSERT OR REPLACE INTO meta(key,value) VALUES ('heartbeat',?)", new Date().toISOString());
  writeFileSync(resolve(dataDir, 'status.json'), JSON.stringify(summary(), null, 2));
};
report();
const timer = setInterval(report, 30_000);
for (const name of ['SIGINT', 'SIGTERM'] as const) process.on(name, () => controller.abort());
log('started', { pid: process.pid, sites: sites.length, dataDir });
try {
  await Promise.all(sites.map(async site => {
    while (!signal.aborted) {
      try { await worker(site); }
      catch (error) { if (!signal.aborted) { log('worker_error', { site: site.domain, error: String(error) }); await pause(30_000).catch(() => {}); } }
    }
  }));
} finally {
  clearInterval(timer); report(); db.close(); unlinkSync(lock); log('stopped', {});
}
