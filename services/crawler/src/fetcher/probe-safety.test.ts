import test from 'node:test';
import assert from 'node:assert/strict';
import { assertProbeWindow } from './probe-safety.js';

test('sidecar probes require an idle failed site beyond the entire test window', () => {
  const idle = { sources: 4, healthy: 0, nextPoll: 1_000_000, pending: 0, unfinished: 0 };
  assert.doesNotThrow(() => assertProbeWindow(idle, 0, 600_000));
  for (const change of [{ sources: 0 }, { healthy: 1 }, { nextPoll: null },
    { nextPoll: 650_000 }, { pending: 1 }, { unfinished: 1 }]) {
    assert.throws(() => assertProbeWindow({ ...idle, ...change }, 0, 600_000));
  }
  assert.throws(() => assertProbeWindow(idle, 580_000, 600_000));
});
