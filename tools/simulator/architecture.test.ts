import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error The deliberately dependency-free check is plain JavaScript.
import { checkBoundaries, violationsFor } from './check-boundaries.mjs';

test('server boundaries pass and reject misplaced outbound calls and service imports', () => {
  assert.deepEqual(checkBoundaries(), []);
  for (const path of ['services/monitor/src/accident.ts', 'apps/dashboard/src/api/accident.ts', 'services/pipeline/src/extract/accident.ts', 'services/crawler/src/loop/accident.ts', 'packages/core/src/accident.ts']) {
    assert.ok(violationsFor(path, "await fetch('https://example.com')").length);
    assert.ok(violationsFor(path, "import https from 'node:https'; https.get(url)").length);
    assert.ok(violationsFor(path, "import client from 'axios'; client(url)").length);
  }
  assert.deepEqual(violationsFor('services/monitor/src/client.ts', 'await fetch(url)'), []);
  assert.deepEqual(violationsFor('services/crawler/src/fetcher/test-client.ts', 'await fetch(url)'), []);
  assert.ok(violationsFor('services/crawler/src/loop/accident.ts', "import {x} from '../../../pipeline/src/index.js'").length);
  assert.ok(violationsFor('services/fetcher-impersonate/cffi-fetch.py', 'import sqlite3').length);
});

test('worker dependency graph cannot reach SQLite or scheduler implementation',async()=>{
  const {readFileSync}=await import('node:fs');
  const visited=new Set<string>();
  function visit(url:URL){
    if(visited.has(url.href))return;visited.add(url.href);
    const source=readFileSync(url,'utf8');
    assert.doesNotMatch(source,/node:sqlite|packages\/db|\/scheduler\//,url.href);
    for(const match of source.matchAll(/from\s*['"](\.[^'"]+)['"]/g))visit(new URL(match[1].replace(/\.js$/,'.ts'),url));
  }
  visit(new URL('../../services/crawler/src/fetcher/index.ts',import.meta.url));
});
