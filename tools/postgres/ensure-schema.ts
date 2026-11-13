// Creates or updates the crawl_budget and reconciler schema objects. Run as the
// service user with the standard PG* environment variables.
import { DatabaseSync } from '../../packages/pg/src/sync.js';
import { ensureSchema } from '../../packages/pg/src/schema.js';

const db = new DatabaseSync();
ensureSchema(db);
db.close();
console.log('crawl_budget and reconciler schemas ready');
