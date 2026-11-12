import type { DatabaseSync } from 'node:sqlite';

export function migrateDurable(db: DatabaseSync) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS crawl_tasks (
        id INTEGER PRIMARY KEY, domain TEXT NOT NULL, url TEXT NOT NULL, purpose TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0, next_crawl_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'ready',
        current_url TEXT NOT NULL, hops INTEGER NOT NULL DEFAULT 0, headers TEXT NOT NULL DEFAULT '{}',
        parent_id INTEGER, origin TEXT, UNIQUE(url,purpose)
      );
      CREATE INDEX IF NOT EXISTS crawl_tasks_due ON crawl_tasks(state,next_crawl_at,priority DESC);
      CREATE INDEX IF NOT EXISTS crawl_tasks_domain_due ON crawl_tasks(domain,purpose,state,next_crawl_at);
      CREATE TABLE IF NOT EXISTS attempt_assignments (
        attempt_id TEXT PRIMARY KEY, request_id INTEGER NOT NULL UNIQUE, task_id INTEGER NOT NULL,
        domain TEXT NOT NULL, worker_id TEXT NOT NULL, claim_id TEXT NOT NULL UNIQUE, lease_token TEXT NOT NULL,
        start_by INTEGER NOT NULL, lease_until INTEGER NOT NULL, assignment TEXT NOT NULL,
        terminal TEXT, completion TEXT, processing TEXT NOT NULL DEFAULT 'waiting',
        process_after INTEGER NOT NULL DEFAULT 0, process_errors INTEGER NOT NULL DEFAULT 0, process_error TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS active_domain_assignment ON attempt_assignments(domain) WHERE terminal IS NULL;
      CREATE INDEX IF NOT EXISTS attempts_processing ON attempt_assignments(processing,process_after);
      CREATE TABLE IF NOT EXISTS scheduler_domains(domain TEXT PRIMARY KEY, articles_since_poll INTEGER NOT NULL DEFAULT 2);
    `);
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
