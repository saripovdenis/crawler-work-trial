import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('transport accounts for robots, redirects and failures; respects robots and Retry-After', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crawler-test-'));
  process.env.CRAWLER_DATA_DIR = dir;
  const { db, run, all, get } = await import('../packages/db/src/store.js');
  const { request, Denied } = await import('./http.js');
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); calls.push(url);
    assert.equal(init?.redirect, 'manual');
    const path = new URL(url).pathname;
    if (path === '/robots.txt') return new Response('User-agent: *\nDisallow: /private\n', { status: 200 });
    if (path === '/go') return new Response('', { status: 302, headers: { location: '/article' } });
    if (path === '/broken') throw new Error('simulated failure');
    if (path === '/escape') return new Response('', { status: 302, headers: { location: 'https://unlisted.example/article' } });
    if (path === '/busy') return new Response('', { status: 429, headers: { 'retry-after': '120' } });
    return new Response('<html>Article</html>', { status: 200 });
  }) as typeof fetch;
  try {
    run('INSERT INTO sites(domain,started) VALUES (?,?)', 'bbc.com', Date.now());
    assert.equal((await request('https://www.bbc.com/go', 'test')).status, 200);
    const before = calls.length;
    await assert.rejects(request('https://www.bbc.com/private', 'test'), Denied);
    assert.equal(calls.length, before);
    await assert.rejects(request('https://www.bbc.com/broken', 'test'), /simulated failure/);
    await assert.rejects(request('https://www.bbc.com/escape', 'test'), Denied);
    await request('https://www.bbc.com/busy', 'test');
    const rows = all<{ started: number; status: number; error: string }>('SELECT * FROM requests ORDER BY id');
    assert.equal(rows.length, calls.length);
    assert.equal(rows.length, 6);
    assert.ok(rows.some(r => r.error?.includes('simulated failure')));
    assert.ok(rows.some(r => r.status === 302));
    for (let i = 1; i < rows.length; i++) assert.ok(rows[i].started - rows[i - 1].started >= 1000);
    assert.ok(get<{ cooldown: number }>('SELECT cooldown FROM sites')!.cooldown >= Date.now() + 119_000);
  } finally {
    globalThis.fetch = original; db.close(); rmSync(dir, { recursive: true, force: true });
  }
});
