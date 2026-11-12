import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error The deliberately dependency-free check is plain JavaScript.
import { checkBoundaries, violationsFor } from './check-boundaries.mjs';

test('server boundaries pass and reject misplaced outbound calls and service imports', () => {
  assert.deepEqual(checkBoundaries(), []);
  for (const path of ['apps/dashboard/src/api/accident.ts', 'services/pipeline/src/extract/accident.ts', 'services/crawler/src/loop/accident.ts', 'packages/core/src/accident.ts']) {
    assert.ok(violationsFor(path, "await fetch('https://example.com')").length);
    assert.ok(violationsFor(path, "import https from 'node:https'; https.get(url)").length);
    assert.ok(violationsFor(path, "import client from 'axios'; client(url)").length);
  }
  assert.deepEqual(violationsFor('services/crawler/src/fetcher/test-client.ts', 'await fetch(url)'), []);
  assert.ok(violationsFor('services/crawler/src/loop/accident.ts', "import {x} from '../../../pipeline/src/index.js'").length);
  assert.ok(violationsFor('services/fetcher-impersonate/cffi-fetch.py', 'import sqlite3').length);
});
