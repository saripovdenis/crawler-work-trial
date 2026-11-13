// Creates the crawl_budget schema objects if they are missing. Run as the
// service user with the standard PG* environment variables.
import { DatabaseSync } from '../../packages/pg/src/sync.js';
import { ensureSchema } from '../../packages/pg/src/schema.js';

const db = new DatabaseSync();
ensureSchema(db);
db.close();
console.log('crawl_budget schema ready');
