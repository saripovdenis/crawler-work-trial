import type { DatabaseSync } from '../../../../packages/pg/src/sync.js';
import { budgetDue } from '../../../../packages/core/src/policy.js';
import { policy, siteRules } from '../../../../config/site-policy.js';

// Read-only eligibility check; reserveSlot repeats it inside the write transaction.
export function slotDue(db: DatabaseSync, domain: string, crawlDelay: number, now: number): number {
  const configured = policy.for(domain);
  if (!configured?.enabled) return Infinity;
  const site = db.prepare('SELECT started,cooldown FROM sites WHERE domain=?').get(domain) as { started: number; cooldown: number } | undefined;
  if (!site) return Infinity;
  const recent = (db.prepare('SELECT started,finished FROM requests WHERE domain=? ORDER BY started DESC,id DESC LIMIT ?')
    .all(domain, siteRules.maxRequestsPerMinute + 1) as { started: number; finished: number | null }[]).reverse();
  return budgetDue(now, site.started, configured.requestsPerMinute, recent, site.cooldown, crawlDelay);
}

export function reserveSlot(db: DatabaseSync, domain: string, url: string,
  purpose: string, crawlDelay: number, clock?: number): { id?: number; due: number } {
  const ownsTransaction = !db.isTransaction;
  if (ownsTransaction) db.exec('BEGIN IMMEDIATE');
  try {
    const now = clock ?? Date.now();
    const due = slotDue(db, domain, crawlDelay, now);
    const id = due <= now ? Number(db.prepare('INSERT INTO requests(domain,url,purpose,started) VALUES (?,?,?,?)').run(domain, url, purpose, now).lastInsertRowid) : undefined;
    if (ownsTransaction) db.exec('COMMIT');
    return { id, due };
  } catch (error) { if (ownsTransaction) db.exec('ROLLBACK'); throw error; }
}
