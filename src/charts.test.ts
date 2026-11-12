import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { Charts, chartWindows } from './charts.js';

test('parsing-quality endpoint: all windows, boundaries, persisted definition, zero domain, cache and read-only DB', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'charts-'));
  const db = new DatabaseSync(join(dir, 'crawler.sqlite'));
  db.exec('CREATE TABLE articles(domain TEXT,fetched INTEGER,classification TEXT);');
  const now = Date.now();
  const insert = db.prepare('INSERT INTO articles VALUES (?,?,?)');
  for (const age of [1000,600_000,2000_000,7200_000,43200_000,172800_000,700000_000]) {
    insert.run('bbc.com', now-age, 'incomplete');
    insert.run('bbc.com', now-age, 'unknown_date'); // Missing date alone is not incomplete.
    insert.run('hoodline.com', now-age, 'old'); // Old parsed posts belong in denominator.
  }
  const charts = new Charts(dir);
  try {
    assert.throws(() => charts.db.exec('DELETE FROM articles'), /readonly/);
    for (const [window, duration] of Object.entries(chartWindows)) {
      const params = new URLSearchParams({ window });
      const result = charts.parsingQuality(params, now);
      const sql = db.prepare("SELECT count(*) total,sum(classification='incomplete') incomplete FROM articles WHERE fetched>=? AND fetched<?").get(now-duration,now)!;
      assert.equal(result.overall.total, sql.total);
      assert.equal(result.overall.incomplete, sql.incomplete);
      assert.equal(result.domains.length, 20);
      assert.deepEqual(result.domains.find(r => r.domain === 'sina.com.cn'), { domain:'sina.com.cn',total:0,incomplete:0,percentage:null });
      assert.equal(result.domains[0].domain, 'bbc.com');
      assert.strictEqual(charts.parsingQuality(params, now+9999), result);
      assert.notStrictEqual(charts.parsingQuality(params, now+10000), result);
    }
    assert.throws(() => charts.parsingQuality(new URLSearchParams('window=2h')), /Invalid/);
    insert.run('bbc.com', now+1_000_000-300_000, 'incomplete');
    insert.run('bbc.com', now+1_000_000, 'incomplete');
    const boundary = charts.parsingQuality(new URLSearchParams('window=5m'),now+1_000_000);
    assert.equal(boundary.overall.total, 1); // Start inclusive, end exclusive.
    assert.equal(charts.parsingQuality(new URLSearchParams('window=5m'),now+2_000_000).overall.percentage,null);
  } finally { charts.db.close(); db.close(); }

  // Exercise the actual API router, including its 400 response.
  const port = await new Promise<number>(resolve => {
    const socket = createServer(); socket.listen(0,'127.0.0.1',()=>{
      const port=(socket.address() as {port:number}).port; socket.close(()=>resolve(port));
    });
  });
  writeFileSync(join(dir,'index.html'), '<html>fixture</html>');
  const child = spawn(process.execPath,['--import','tsx','src/api.ts'], {
    env:{...process.env,PORT:String(port),CRAWLER_DATA_DIR:dir,DASHBOARD_DIST:dir},stdio:['ignore','pipe','pipe'],
  });
  try {
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('API startup timeout')),10000);
      child.stdout.once('data',()=>{clearTimeout(timer);resolve();});
      child.once('exit',()=>{clearTimeout(timer);reject(new Error('API exited'));});
    });
    for (const window of Object.keys(chartWindows)) {
      const response = await fetch(`http://127.0.0.1:${port}/api/charts/parsing-quality?window=${window}`);
      assert.equal(response.status,200);
      const body = await response.json();
      assert.equal(body.window,window); assert.equal(body.domains.length,20);
      assert.equal(body.domains.find((r: {domain:string})=>r.domain==='sina.com.cn').percentage,null);
    }
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/charts/parsing-quality?window=bad`)).status,400);
  } finally {
    const exited = new Promise(resolve=>child.once('exit',resolve)); child.kill('SIGTERM'); await exited;
    rmSync(dir,{recursive:true,force:true});
  }
});
