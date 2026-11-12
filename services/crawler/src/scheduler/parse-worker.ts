import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import type { ParseInput, ParseResult as CachedParseResult } from '../../../../packages/core/src/extraction-cache.js';
export type { ParseInput } from '../../../../packages/core/src/extraction-cache.js';
export type ParseResult = CachedParseResult & {timings?:{worker_ms:number;extraction_ms:number;cache_archive_ms:number}};

type Pending = { id: number; timer: ReturnType<typeof setTimeout>; resolve(value: ParseResult): void; reject(error: Error): void };

// One archive at a time. SQLite remains the queue and retry authority; this
// helper never accumulates a second in-memory work queue or accesses the DB.
export class ArchiveParser {
  private worker?: Worker;
  private pending?: Pending;
  private sequence = 0;
  private closed = false;
  metrics: Record<string,number> = {};
  constructor(readonly directory: string) {}

  parse(input: ParseInput): Promise<ParseResult> {
    if (this.closed) return Promise.reject(new Error('Archive parser is closed'));
    if (this.pending) return Promise.reject(new Error('Archive parser is busy'));
    const worker = this.worker ?? this.start();
    worker.ref();
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer=setTimeout(()=> {
        if(this.worker!==worker || this.pending?.id!==id)return;
        this.worker=undefined;this.pending=undefined;
        reject(new Error('Archive parser timed out after 30 seconds'));
        void worker.terminate();
      },30_000);
      timer.unref();
      this.pending = { id, timer, resolve, reject };
      try { worker.postMessage({ id, directory: this.directory, input }); }
      catch (error) { clearTimeout(timer);this.pending = undefined; worker.unref(); reject(error as Error); }
    });
  }

  private start(): Worker {
    const worker = new Worker(new URL('./parse-worker-bootstrap.mjs', import.meta.url), { execArgv: [] });
    this.worker = worker;
    worker.on('message', message => {
      const pending = this.pending;
      if (this.worker !== worker || !pending || message.id !== pending.id) return;
      clearTimeout(pending.timer);
      this.pending = undefined;
      worker.unref();
      if (message.error) {
        const error = new Error(String(message.error.message));
        error.name = String(message.error.name || 'Error');
        pending.reject(error);
      } else {this.metrics=message.metrics ?? this.metrics;pending.resolve(message.result as ParseResult);}
    });
    const failed = (error: Error) => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      const pending = this.pending;
      this.pending = undefined;
      if(pending)clearTimeout(pending.timer);
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
    if(this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error('Archive parser is closed'));
    }
    this.pending = undefined;
    if (worker) await worker.terminate();
  }
}

if (!isMainThread) {
  const { CachedExtractor } = await import('../../../../packages/core/src/extraction-cache.js');
  let extractor: InstanceType<typeof CachedExtractor> | undefined;
  parentPort!.on('message', ({ id, directory, input }: { id: number; directory: string; input: ParseInput }) => {
    try {
      extractor ??= new CachedExtractor(directory);
      const started=performance.now(),before=extractor.metrics.parseMs;
      const result=extractor.parse(input);
      const worker_ms=performance.now()-started,extraction_ms=extractor.metrics.parseMs-before;
      parentPort!.postMessage({id,result:{...result,timings:{worker_ms,extraction_ms,cache_archive_ms:Math.max(0,worker_ms-extraction_ms)}},metrics:extractor.metrics});
    } catch(error) {
      const value=error instanceof Error?error:new Error(String(error));
      parentPort!.postMessage({id,error:{name:value.name,message:value.message}});
    }
  });
}
