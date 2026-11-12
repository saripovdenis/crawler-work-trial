import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { MAX_RESPONSE_BYTES } from '../../../../packages/protocol/src/index.js';
import type { discover, parseArticle } from '../../../../packages/core/src/parse.js';

type Archive = {
  response_ref: string;
  body_hash: string;
  bytes: number;
  headers: Record<string, string>;
  url: string;
};
export type ParseInput = Archive & (
  | { kind: 'discovery'; sourceKind: string }
  | { kind: 'article'; discovered: number; hint: string | null }
);
export type ParseResult =
  | { kind: 'discovery'; found: ReturnType<typeof discover> }
  | { kind: 'article'; article: ReturnType<typeof parseArticle> };
type Pending = { id: number; resolve(value: ParseResult): void; reject(error: Error): void };

// One archive at a time. SQLite remains the queue and retry authority; this
// helper never accumulates a second in-memory work queue or accesses the DB.
export class ArchiveParser {
  private worker?: Worker;
  private pending?: Pending;
  private sequence = 0;
  private closed = false;
  constructor(readonly directory: string) {}

  parse(input: ParseInput): Promise<ParseResult> {
    if (this.closed) return Promise.reject(new Error('Archive parser is closed'));
    if (this.pending) return Promise.reject(new Error('Archive parser is busy'));
    const worker = this.worker ?? this.start();
    worker.ref();
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending = { id, resolve, reject };
      try { worker.postMessage({ id, directory: this.directory, input }); }
      catch (error) { this.pending = undefined; worker.unref(); reject(error as Error); }
    });
  }

  private start(): Worker {
    const worker = new Worker(new URL('./parse-worker-bootstrap.mjs', import.meta.url), { execArgv: [] });
    this.worker = worker;
    worker.on('message', message => {
      const pending = this.pending;
      if (this.worker !== worker || !pending || message.id !== pending.id) return;
      this.pending = undefined;
      worker.unref();
      if (message.error) {
        const error = new Error(String(message.error.message));
        error.name = String(message.error.name || 'Error');
        pending.reject(error);
      } else pending.resolve(message.result as ParseResult);
    });
    const failed = (error: Error) => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      const pending = this.pending;
      this.pending = undefined;
      pending?.reject(error);
    };
    worker.on('error', failed);
    worker.on('exit', code => failed(new Error(`Archive parser exited (${code})`)));
    return worker;
  }

  async close(): Promise<void> {
    this.closed = true;
    const worker = this.worker;
    this.worker = undefined;
    this.pending?.reject(new Error('Archive parser is closed'));
    this.pending = undefined;
    if (worker) await worker.terminate();
  }
}

if (!isMainThread) {
  // These heavy modules load only inside the worker. Main-thread imports above
  // are types, so claims and completions do not initialize JSDOM/Readability.
  const { discover, parseArticle } = await import('../../../../packages/core/src/parse.js');
  parentPort!.on('message', ({ id, directory, input }: { id: number; directory: string; input: ParseInput }) => {
    try {
      if (!/^[a-f0-9]{64}$/.test(input.body_hash)
        || input.response_ref !== `snapshots/${input.body_hash}.gz`
        || !Number.isInteger(input.bytes) || input.bytes < 0 || input.bytes > MAX_RESPONSE_BYTES)
        throw new Error('Invalid archive reference');
      const bytes = gunzipSync(readFileSync(resolve(directory, input.response_ref)), { maxOutputLength: MAX_RESPONSE_BYTES });
      if (bytes.length !== input.bytes || createHash('sha256').update(bytes).digest('hex') !== input.body_hash)
        throw new Error('Archive integrity mismatch');
      const charset = input.headers['content-type']?.match(/charset=["']?([^;"'\s]+)/i)?.[1]
        || bytes.subarray(0, 2048).toString('ascii').match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] || 'utf-8';
      let body: string;
      try { body = new TextDecoder(charset).decode(bytes); } catch { body = bytes.toString('utf8'); }
      const result: ParseResult = input.kind === 'discovery'
        ? { kind: 'discovery', found: discover(body, input.url, input.sourceKind) }
        : { kind: 'article', article: parseArticle(body, input.url, input.discovered, input.hint) };
      parentPort!.postMessage({ id, result });
    } catch (error) {
      const value = error instanceof Error ? error : new Error(String(error));
      parentPort!.postMessage({ id, error: { name: value.name, message: value.message } });
    }
  });
}
