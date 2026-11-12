// Offline integration smoke. Input must be a database snapshot, never a live data directory.
import assert from 'node:assert/strict';
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

const root = fileURLToPath(new URL('../../', import.meta.url));
if (!process.argv[2]) throw new Error('Usage: node --import tsx tools/simulator/check-layout.mjs /path/to/snapshot.sqlite [baseline-checkout]');
const dir = mkdtempSync(join(tmpdir(), 'exa-layout-'));
const children = new Set();
function start(entry, env, preloads = []) {
  const child = spawn(process.execPath, [...preloads, '--import', 'tsx', entry], { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore','pipe','pipe'] });
  child.output = '';
  child.stdout.on('data', x => child.output += x);
  child.stderr.on('data', x => child.output += x);
  child.done = new Promise((ok, fail) => { child.on('error', fail); child.on('exit', code => ok(code)); });
  children.add(child);
  return child;
}
async function stop(child) {
  child.kill('SIGTERM');
  const deadline = setTimeout(() => child.kill('SIGKILL'), 10_000);
  const code = await child.done;
  clearTimeout(deadline); children.delete(child);
  assert.equal(code, 0, child.output);
}
async function until(check, child) {
  for (let i = 0; i < 150; i++) {
    if (await check()) return;
    if (child.exitCode !== null) throw new Error(child.output);
    await sleep(100);
  }
  throw new Error('Timed out: ' + child.output);
}
let db;
try {
  const input = new DatabaseSync(resolve(process.argv[2]), { readOnly: true });
  await backup(input, join(dir, 'crawler.sqlite')); input.close();
  db = new DatabaseSync(join(dir, 'crawler.sqlite'));
  const schema = () => db.prepare("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all();
  const starts = () => db.prepare('SELECT domain,started FROM sites ORDER BY domain').all();
  const originalSchema = schema(), originalStarts = starts();
  const ledger = db.prepare('SELECT count(*) n,max(id) id FROM requests').get();

  // Compare old and new read-only query results on precisely the same frozen snapshot.
  if (process.argv[3]) {
    const before = resolve(process.argv[3]);
    const { Observatory: Old } = await import(pathToFileURL(join(before, 'src/observability.ts')));
    const { Charts: OldCharts } = await import(pathToFileURL(join(before, 'src/charts.ts')));
    const { Observatory: New } = await import('../../apps/dashboard/src/metrics/observability.ts');
    const { Charts: NewCharts } = await import('../../apps/dashboard/src/metrics/charts.ts');
    const old = new Old(dir), next = new New(dir), oldCharts = new OldCharts(dir), nextCharts = new NewCharts(dir);
    const realNow = Date.now; const now = realNow(); Date.now = () => now;
    try {
      assert.deepEqual(next.overview(), old.overview());
      for (const method of ['requests','articles','sources']) for (const query of ['', 'domain=bbc.com', 'fresh=true&q=news'])
        assert.deepEqual(next[method](new URLSearchParams(query)), old[method](new URLSearchParams(query)));
      for (const window of ['5m','30m','1h','3h','1d','1w'])
        assert.deepEqual(nextCharts.parsingQuality(new URLSearchParams({window})), oldCharts.parsingQuality(new URLSearchParams({window})));
      assert.deepEqual(await next.requestDetail(ledger.id), await old.requestDetail(ledger.id));
      console.log('Baseline API parity passed: overview, filters, detail, six chart windows');
    } finally { Date.now = realNow; for (const x of [old,next,oldCharts,nextCharts]) x.db.close(); }
  }

  const crawler = start('services/crawler/src/loop/index.ts', { CRAWLER_DATA_DIR: dir, CRAWLER_PYTHON: join(root, 'tools/simulator/fake-python.cjs') }, ['--import', join(root, 'tools/simulator/preload.mjs')]);
  await until(() => crawler.output.includes('"started"') && db.prepare('SELECT count(*) n FROM requests WHERE id>? AND finished IS NOT NULL').get(ledger.id).n > 0, crawler);
  await stop(crawler);
  assert.ok(!existsSync(join(dir, 'crawler.pid')));
  assert.deepEqual(schema(), originalSchema); assert.deepEqual(starts(), originalStarts);
  assert.equal(db.prepare('SELECT count(*) n FROM requests WHERE id<=?').get(ledger.id).n, ledger.n);
  assert.ok(!crawler.output.includes('worker_error'), crawler.output);
  console.log('Crawler starts/stops with fixture transport; schema, start times and existing ledger preserved');

  const socket = createServer(); await new Promise(ok => socket.listen(0, '127.0.0.1', ok));
  const port = socket.address().port; await new Promise(ok => socket.close(ok));
  const api = start('apps/dashboard/src/api/index.ts', { CRAWLER_DATA_DIR: dir, HOST: '127.0.0.1', PORT: String(port) });
  await until(() => api.output.includes('listening'), api);
  for (const path of ['/api/health','/api/overview','/api/requests','/api/articles','/api/sources','/api/charts/parsing-quality?window=1w','/','/charts']) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    assert.equal(response.status, 200, path); await response.text();
  }
  await stop(api);
  const { parseArticle } = await import('../../services/pipeline/src/index.ts');
  const parsed = parseArticle(readFileSync(join(root, 'fixtures/article.html'), 'utf8'), 'https://example.com/news/articles/100001', Date.now(), null);
  assert.ok(parsed.title && parsed.text.length >= 200);
  assert.deepEqual(schema(), originalSchema);
  console.log('Dashboard API/static routes and pipeline fixture extraction passed');
} finally {
  for (const child of children) { child.kill('SIGKILL'); await child.done; }
  db?.close(); rmSync(dir, { recursive: true, force: true });
}
