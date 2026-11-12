import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { reserveSlot } from './budget.js';

function open(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS sites(domain TEXT PRIMARY KEY,started INTEGER,cooldown INTEGER);
    CREATE TABLE IF NOT EXISTS requests(id INTEGER PRIMARY KEY,domain TEXT,url TEXT,purpose TEXT,started INTEGER,finished INTEGER);
    INSERT OR IGNORE INTO sites VALUES ('eleconomista.es',0,0);`);
  return db;
}
test('budget survives reopen, charges unfinished attempts, and preserves server cooldown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'budget-'));
  const path = join(dir, 'test.sqlite');
  let db = open(path);
  const reserve = (now: number) => reserveSlot(db, 'eleconomista.es', 'https://www.eleconomista.es/', 'test', 2, 0, now);
  try {
    const first = reserve(700_000);
    assert.ok(first.id);
    db.close(); db = open(path);
    assert.deepEqual(reserve(701_000), { id: undefined, due: 765_020 });
    db.prepare('UPDATE requests SET finished=701000').run();
    assert.equal(reserve(710_000).due, 731_020);
    assert.ok(reserve(731_020).id);
    db.prepare('UPDATE sites SET cooldown=900000').run();
    db.close(); db = open(path);
    assert.equal(reserve(800_000).due, 900_000);
    assert.equal(db.prepare('SELECT count(*) n FROM requests').get()!.n, 2);
    assert.equal(db.prepare('SELECT started FROM sites').get()!.started, 0);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('two processes cannot both reserve the same request slot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'budget-race-'));
  const path = join(dir, 'test.sqlite');
  const db = open(path); db.close();
  const code = `import { DatabaseSync } from 'node:sqlite';
    import { reserveSlot } from ${JSON.stringify(new URL('./budget.ts', import.meta.url).href)};
    const db = new DatabaseSync(process.argv[1]); db.exec('PRAGMA busy_timeout=5000');
    console.log(JSON.stringify(reserveSlot(db,'eleconomista.es','https://www.eleconomista.es/','test',2,0,700000))); db.close();`;
  const child = () => new Promise<{ id?: number; due: number }>((resolve, reject) => {
    const p = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, path]);
    let output = ''; let errors = '';
    p.stdout.on('data', data => output += data); p.stderr.on('data', data => errors += data);
    p.on('error', reject); p.on('exit', status => status === 0 ? resolve(JSON.parse(output)) : reject(new Error(errors)));
  });
  try {
    const results = await Promise.all([child(), child()]);
    assert.equal(results.filter(r => r.id !== undefined).length, 1);
    assert.equal(results.find(r => r.id === undefined)!.due, 765_020);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
