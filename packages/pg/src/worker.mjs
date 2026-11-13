// One PostgreSQL session per synchronous handle. The owning thread blocks on
// the shared flag until this worker has posted the reply.
import { workerData } from 'node:worker_threads';
import pg from 'pg';

const { port, shared, readOnly } = workerData;
const flag = new Int32Array(shared);
// Match what the callers received from SQLite: numbers, and 0/1 for booleans.
pg.types.setTypeParser(20, Number);
pg.types.setTypeParser(1700, Number);
pg.types.setTypeParser(16, value => (value === 't' ? 1 : 0));
const client = new pg.Client({ application_name: 'exa-crawler' });
client.on('error', error => console.error('PostgreSQL connection error', String(error)));
const ready = client.connect().then(() => client.query(
  'SET search_path TO crawl_budget' + (readOnly ? '; SET default_transaction_read_only=on' : '')));
ready.catch(() => {});
port.on('message', async message => {
  let reply;
  try {
    await ready;
    if (message.op === 'close') { await client.end(); reply = {}; }
    else {
      const result = await client.query(message.values ? { name: message.name, text: message.text, values: message.values } : message.text);
      const last = Array.isArray(result) ? result.at(-1) : result;
      reply = { rows: last?.rows ?? [], rowCount: last?.rowCount ?? 0 };
    }
  } catch (error) { reply = { error: { message: String(error?.message ?? error), code: error?.code } }; }
  port.postMessage(reply);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
});
