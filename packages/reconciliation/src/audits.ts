import { DatabaseSync, hasTable } from "../../pg/src/sync.js";
import { domainFor } from "../../core/src/policy.js";
import { urlKey } from "./identity.js";

// Called only by the scheduler. The monitor never writes the crawler database.
// Cursor and tasks commit together, so importing the same batch is idempotent.
export function importAudits(
  db: DatabaseSync,
  monitorPath: string,
  now = Date.now(),
) {
  if (!hasTable('audit_candidates')) return 0;
  const monitor = new DatabaseSync(monitorPath, { readOnly: true });
  try {
    monitor.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000");
    const cursor = Number(
      db.prepare("SELECT value FROM meta WHERE key='audit_import_cursor'").get()
        ?.value || 0,
    );
    const rows = monitor
      .prepare(
        "SELECT rowid id,* FROM audit_candidates WHERE rowid>? AND created_at<=? ORDER BY rowid LIMIT 200",
      )
      .all(cursor, now - 30 * 60_000);
    if (!rows.length) return 0;
    const known = new Set(
      db
        .prepare(
          "SELECT canonical_url url FROM articles UNION SELECT json_extract(payload,'$.sourceUrl') url FROM articles",
        )
        .all()
        .map((row) => row.url && urlKey(String(row.url))),
    );
    let added = 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const url = String(row.url),
          key = urlKey(url);
        if (
          !key ||
          domainFor(url) !== row.domain ||
          known.has(key) ||
          db.prepare("SELECT 1 FROM candidates WHERE url=?").get(url)
        )
          continue;
        added += Number(
          db
            .prepare(
              "INSERT OR IGNORE INTO crawl_tasks(domain,url,purpose,priority,next_crawl_at,current_url) VALUES (?,?,'audit',-100,?,?)",
            )
            .run(row.domain, url, now, url).changes,
        );
      }
      db.prepare(
        "INSERT OR REPLACE INTO meta(key,value) VALUES ('audit_import_cursor',?)",
      ).run(String(rows.at(-1)!.id));
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return added;
  } finally {
    monitor.close();
  }
}
