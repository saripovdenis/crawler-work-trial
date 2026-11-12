import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { discover, parseArticle } from '../../../../packages/core/src/parse.js';
import { ArchiveParser, type ParseInput } from './parse-worker.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'archive-parser-'));
  mkdirSync(join(dir, 'snapshots'));
  const parser = new ArchiveParser(dir);
  const archive = (body: string | Buffer) => {
    const bytes = Buffer.from(body), hash = createHash('sha256').update(bytes).digest('hex');
    const ref = `snapshots/${hash}.gz`;
    writeFileSync(join(dir, ref), gzipSync(bytes));
    return { response_ref: ref, body_hash: hash, bytes: bytes.length, headers: {}, url: 'https://www.bbc.com/news/test' };
  };
  return { dir, parser, archive, close: async () => { await parser.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('worker extraction matches existing parser while main event loop stays responsive', async () => {
  const f = fixture();
  const body = readFileSync(new URL('../../../../fixtures/article.html', import.meta.url), 'utf8');
  const input: ParseInput = { ...f.archive(body), kind: 'article', discovered: 1_000_000, hint: null };
  let ticks = 0;
  const timer = setInterval(() => ticks++, 2);
  try {
    const result = await f.parser.parse(input);
    assert.equal(result.kind, 'article');
    assert.deepEqual(result.kind === 'article' && result.article, parseArticle(body, input.url, input.discovered, input.hint));
    assert.ok(ticks >= 2, `main thread timer stalled (${ticks} ticks)`);
  } finally { clearInterval(timer); await f.close(); }
});

test('discovery, charset handling, and partial RSS semantics are preserved in the worker', async () => {
  const f = fixture();
  try {
    const body = '<rss><channel><item><link>https://www.bbc.com/news/whole</link><pubDate>2026-11-12T08:00:00Z</pubDate></item><item><link>broken';
    const input: ParseInput = { ...f.archive(body), kind: 'discovery', sourceKind: 'feed' };
    const result = await f.parser.parse(input);
    assert.deepEqual(result, { kind: 'discovery', found: discover(body, input.url, 'feed') });
    const latin = Buffer.from('<html><a href="/news/articles/123456">Caf\xe9 news story headline</a></html>', 'latin1');
    const encoded: ParseInput = { ...f.archive(latin), headers: { 'content-type': 'text/html; charset=iso-8859-1' }, kind: 'discovery', sourceKind: 'html' };
    assert.deepEqual(await f.parser.parse(encoded), { kind: 'discovery', found: discover(latin.toString('latin1'), encoded.url, 'html') });
  } finally { await f.close(); }
});

test('archive corruption and invalid paths fail without poisoning later jobs', async () => {
  const f = fixture();
  try {
    const input: ParseInput = { ...f.archive('<rss><channel/></rss>'), kind: 'discovery', sourceKind: 'feed' };
    await assert.rejects(f.parser.parse({ ...input, response_ref: '../outside.gz' }), /Invalid archive reference/);
    await assert.rejects(f.parser.parse({ ...input, bytes: input.bytes + 1 }), /Archive integrity mismatch/);
    const bad = { ...input, body_hash: 'a'.repeat(64), response_ref: `snapshots/${'a'.repeat(64)}.gz` };
    writeFileSync(join(f.dir, bad.response_ref), gzipSync(Buffer.from('different data')));
    await assert.rejects(f.parser.parse(bad), /Archive integrity mismatch/);
    assert.equal((await f.parser.parse(input)).kind, 'discovery');
  } finally { await f.close(); }
});

test('worker accepts one pending archive and closes without losing a pending promise', async () => {
  const f = fixture();
  const input: ParseInput = { ...f.archive('<rss><channel/></rss>'), kind: 'discovery', sourceKind: 'feed' };
  try {
    const first = f.parser.parse(input);
    await assert.rejects(f.parser.parse(input), /busy/);
    await first;
    const interrupted = f.parser.parse(input);
    const rejection = assert.rejects(interrupted, /closed/);
    await f.parser.close();
    await rejection;
    await assert.rejects(f.parser.parse(input), /closed/);
  } finally { await f.close(); }
});

test('a crashed parser rejects in-flight work and a later durable retry can use a new worker', async () => {
  const f = fixture();
  const input: ParseInput = { ...f.archive('<rss><channel/></rss>'), kind: 'discovery', sourceKind: 'feed' };
  try {
    const pending = f.parser.parse(input);
    const rejection = assert.rejects(pending, /Archive parser exited/);
    // Fault injection: simulate an unexpected worker exit, not a service close.
    await (f.parser as unknown as { worker: { terminate(): Promise<number> } }).worker.terminate();
    await rejection;
    assert.deepEqual(await f.parser.parse(input), { kind: 'discovery', found: { articles: [], sources: [], partial: false } });
  } finally { await f.close(); }
});
