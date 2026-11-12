import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchResponse, usesChromeProfile } from './transport.js';

test('only the two configured sites use Chrome, including their subdomains', () => {
  assert.equal(usesChromeProfile('https://hoodline.com/'), true);
  assert.equal(usesChromeProfile('https://www.eleconomista.es/'), true);
  assert.equal(usesChromeProfile('https://bbc.com/'), false);
  assert.equal(usesChromeProfile('https://hoodline.com.evil.test/'), false);
});
test('Python transport preserves conditional headers, redirects, 304s, errors and cancellation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'transport-'));
  const executable = join(dir, 'fake-python');
  writeFileSync(executable, `#!/usr/bin/env node
let input=''; process.stdin.on('data', b=>input+=b); process.stdin.on('end', ()=>{
 const args=JSON.parse(input);
 if(args.profile!=='cffi-chrome'||args.headers['User-Agent']) process.exit(1);
 if(args.url.endsWith('/slow')) { setTimeout(()=>{},60000); return; }
 if(args.url.endsWith('/fail')) { console.log(JSON.stringify({error:'fixture TLS failure'})); return; }
 const status=args.url.endsWith('/redirect')?302:args.url.endsWith('/cached')?304:200;
 console.log(JSON.stringify({status,headers:{location:'/final','x-etag':args.headers['If-None-Match']||''},body:Buffer.from('article').toString('base64')}));
});`, { mode: 0o755 });
  const previous = process.env.CRAWLER_PYTHON;
  process.env.CRAWLER_PYTHON = executable;
  try {
    const response = await fetchResponse('https://hoodline.com/redirect', { 'If-None-Match': 'abc' }, new AbortController().signal);
    assert.equal(response.status, 302); // Caller must reserve another slot before following.
    assert.equal(response.headers.get('x-etag'), 'abc');
    assert.equal(await response.text(), 'article');
    const cached = await fetchResponse('https://hoodline.com/cached', {}, new AbortController().signal);
    assert.equal(cached.status, 304); assert.equal(await cached.text(), '');
    await assert.rejects(fetchResponse('https://hoodline.com/fail', {}, new AbortController().signal), /fixture TLS failure/);
    const controller = new AbortController();
    const pending = fetchResponse('https://hoodline.com/slow', {}, controller.signal);
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(pending, /abort/i);
  } finally {
    if (previous === undefined) delete process.env.CRAWLER_PYTHON; else process.env.CRAWLER_PYTHON = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
