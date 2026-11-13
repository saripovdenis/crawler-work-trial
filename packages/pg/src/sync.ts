import { Worker, MessageChannel, receiveMessageOnPort, type MessagePort } from 'node:worker_threads';
import { createHash } from 'node:crypto';

// Synchronous PostgreSQL handle with the small node:sqlite surface this code
// uses. Connection settings come from the standard PG* environment variables;
// every handle resolves names in the crawl_budget and reconciler schemas.
type Row = Record<string, any>;
const keys: Record<string, string> = { meta: 'key', monitor_meta: 'key', robots: 'origin' };
const columns: Record<string, string[]> = { monitor_meta: ['key', 'value'] };

// The statements were written for SQLite. These are the only dialect
// differences they rely on; anything else is written portably at the call site.
export function translate(sql: string, placeholders = true): string {
  let text = sql.replace(/\bINDEXED BY \w+/gi, '').replace(/\bCROSS JOIN\b/gi, 'JOIN')
    .replace(/\bBEGIN IMMEDIATE\b/gi, 'BEGIN')
    .replace(/CAST\(([^()]+) AS INTEGER\)/gi, 'CAST($1 AS BIGINT)')
    .replace(/\bsqlite_master WHERE name=/gi, 'information_schema.tables WHERE table_schema=ANY(current_schemas(false)) AND table_name=')
    .replace(/\bAS ([a-z]+[A-Z]\w*)/g, 'AS "$1"');
  const replace = /^\s*INSERT OR REPLACE INTO (\w+)\s*(?:\(([^)]*)\))?/i.exec(text);
  if (/^\s*INSERT OR IGNORE INTO/i.test(text)) text = text.replace(/INSERT OR IGNORE INTO/i, 'INSERT INTO').replace(/;?\s*$/, '') + ' ON CONFLICT DO NOTHING';
  else if (replace) {
    const table = replace[1]!.toLowerCase(), key = keys[table], names = (replace[2]?.split(',') ?? columns[table])?.map(name => name.trim());
    if (!key || !names) throw new Error(`No replace rule for table ${table}`);
    text = text.replace(/INSERT OR REPLACE INTO/i, 'INSERT INTO').replace(/;?\s*$/, '')
      + ` ON CONFLICT (${key}) DO UPDATE SET ${names.filter(name => name !== key).map(name => `${name}=excluded.${name}`).join(',')}`;
  }
  if (/^\s*INSERT INTO (requests|provider_runs)\b/i.test(text) && !/\bRETURNING\b/i.test(text)) text += ' RETURNING id';
  if (!placeholders) return text;
  let out = '', quoted = false, index = 0;
  for (const char of text) {
    if (char === "'") quoted = !quoted;
    out += char === '?' && !quoted ? '$' + ++index : char;
  }
  return out;
}

export class StatementSync {
  private readonly text: string;
  private readonly name: string;
  constructor(private readonly db: DatabaseSync, sql: string) {
    this.text = translate(sql);
    this.name = 's' + createHash('sha1').update(this.text).digest('hex').slice(0, 24);
  }
  private query(values: unknown[]) {
    return this.db.call({ text: this.text, name: this.name, values: values.map(value => value === undefined ? null : value) });
  }
  all(...values: unknown[]): Row[] { return this.query(values).rows; }
  get(...values: unknown[]): Row | undefined { return this.query(values).rows[0]; }
  run(...values: unknown[]): { changes: number; lastInsertRowid: number } {
    const result = this.query(values);
    return { changes: result.rowCount, lastInsertRowid: Number(result.rows[0]?.id ?? 0) };
  }
}

export class DatabaseSync {
  isTransaction = false;
  private readonly flag: Int32Array;
  private readonly port: MessagePort;
  private readonly worker: Worker;
  private closed = false;
  // The path is accepted for call-site compatibility and ignored.
  constructor(_path?: string, options: { readOnly?: boolean } = {}) {
    const shared = new SharedArrayBuffer(4), channel = new MessageChannel();
    this.flag = new Int32Array(shared); this.port = channel.port1;
    this.worker = new Worker(new URL('./worker.mjs', import.meta.url), {
      execArgv: [], workerData: { shared, port: channel.port2, readOnly: !!options.readOnly }, transferList: [channel.port2],
    });
    this.worker.unref();
  }
  call(message: Row): { rows: Row[]; rowCount: number } {
    if (this.closed) throw new Error('Database is closed');
    Atomics.store(this.flag, 0, 0);
    this.port.postMessage(message);
    if (Atomics.wait(this.flag, 0, 0, 120_000) === 'timed-out') throw new Error('PostgreSQL query timed out');
    const reply = receiveMessageOnPort(this.port)?.message;
    if (!reply) throw new Error('PostgreSQL worker did not reply');
    if (reply.error) {
      // A lost session cannot be resumed. Exit so the service manager starts a
      // clean process; durable leases and charges make that restart safe.
      if (/^(08|57P)/.test(String(reply.error.code ?? '')) || /Connection terminated|ECONNREFUSED|ECONNRESET|ENOENT|EPIPE|not queryable|connection error/i.test(reply.error.message)) {
        console.error('PostgreSQL session lost; exiting for restart:', reply.error.message);
        process.exit(1);
      }
      throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
    }
    return reply;
  }
  prepare(sql: string) { return new StatementSync(this, sql); }
  exec(sql: string) {
    for (const statement of sql.split(';').map(part => part.trim()).filter(part => part && !/^PRAGMA\b/i.test(part))) {
      this.call({ text: translate(statement, false) });
      if (/^BEGIN\b/i.test(statement)) this.isTransaction = true;
      else if (/^(COMMIT|ROLLBACK)\b/i.test(statement)) this.isTransaction = false;
    }
  }
  tableExists(name: string) {
    return !!this.prepare('SELECT 1 FROM information_schema.tables WHERE table_schema=ANY(current_schemas(false)) AND table_name=?').get(name);
  }
  close() {
    if (this.closed) return;
    try { this.call({ op: 'close' }); } catch { /* already gone */ }
    this.closed = true; this.port.close(); void this.worker.terminate();
  }
}

// Readers used to test whether the other service's database file existed.
export function hasTable(name: string) {
  const db = new DatabaseSync(undefined, { readOnly: true });
  try { return db.tableExists(name); } finally { db.close(); }
}
