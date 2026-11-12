import { resolve } from 'node:path';
import { runWorker } from './remote-worker.js';
const controller=new AbortController();
for(const event of ['SIGTERM','SIGINT']) process.on(event,()=>controller.abort());
await runWorker(resolve(process.env.CRAWLER_DATA_DIR||'data'),process.env.SCHEDULER_URL||'http://127.0.0.1:4319',Number(process.env.FETCH_CONCURRENCY||4),controller.signal);
