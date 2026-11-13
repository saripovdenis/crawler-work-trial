import type { DatabaseSync } from '../../../pg/src/sync.js';
import { ensureSchema } from '../../../pg/src/schema.js';

export function migrateDurable(db: DatabaseSync) {
  db.exec('BEGIN IMMEDIATE');
  try {
    ensureSchema(db);
    syncTasks(db);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
// Existing due times are copied exactly. Never overwrite a leased/downloaded task.
export function syncTasks(db: DatabaseSync) {
  db.exec(`
    INSERT OR IGNORE INTO scheduler_domains(domain) SELECT domain FROM sites;
    INSERT OR IGNORE INTO crawl_tasks(domain,url,purpose,next_crawl_at,current_url)
      SELECT domain,url,'discovery',next_poll,url FROM sources;
    INSERT OR IGNORE INTO crawl_tasks(domain,url,purpose,priority,next_crawl_at,current_url)
      SELECT domain,url,'article',priority,next_attempt,url FROM candidates WHERE state='pending';
    UPDATE crawl_tasks SET priority=(SELECT priority FROM candidates WHERE candidates.url=crawl_tasks.url)
      WHERE purpose='article' AND state='ready'
      AND priority<>(SELECT priority FROM candidates WHERE candidates.url=crawl_tasks.url);
  `);
}
