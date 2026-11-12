import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const cmd = process.argv[2] || 'status';
const dataDir = resolve(process.env.CRAWLER_DATA_DIR || 'data');
mkdirSync(dataDir, { recursive: true });
const lock = resolve(dataDir, 'crawler.pid');
const pid = existsSync(lock) ? Number(readFileSync(lock, 'utf8')) : 0;
let running = false;
if (pid) { try { process.kill(pid, 0); running = true; } catch {} }
if (cmd === 'start') {
  if (running) console.log(`Already running: PID ${pid}`);
  else {
    mkdirSync('logs', { recursive: true });
    const log = openSync('logs/crawler.log', 'a');
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: process.cwd(), detached: true, stdio: ['ignore', log, log], env: process.env });
    child.unref(); closeSync(log);
    await sleep(1500);
    if (!existsSync(lock)) throw new Error('Crawler did not start; inspect logs/crawler.log');
    process.kill(Number(readFileSync(lock, 'utf8')), 0);
    console.log(`Crawler running: PID ${readFileSync(lock, 'utf8')}. Logs: logs/crawler.log`);
  }
} else if (cmd === 'stop') {
  if (running) {
    process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 100 && existsSync(lock); i++) await sleep(100);
    if (existsSync(lock)) throw new Error(`PID ${pid} is still shutting down`);
    console.log(`Stopped PID ${pid}`);
  }
  else console.log('Not running');
} else if (cmd === 'status') {
  console.log(running ? `Running: PID ${pid}` : 'Not running');
  const { summary, db } = await import('../packages/db/src/store.js');
  const status = summary();
  console.log(`Started: ${status.firstStartedAt || 'never'} | Heartbeat: ${status.heartbeat || 'none'}`);
  console.table(status.sites); console.table(status.classifications);
  console.table(status.delay); console.log(`Coverage: ${status.coverage}`); db.close();
} else throw new Error('Use start, stop, or status');
