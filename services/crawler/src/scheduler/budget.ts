import type { DatabaseSync } from '../../../../packages/pg/src/sync.js';
import { currentRequestLimit, siteAvailableAt } from '../../../../packages/core/src/policy.js';
import { policy, siteRules } from '../../../../config/site-policy.js';

export function slotDue(db: DatabaseSync, domain: string, now: number): number {
  if (!policy.for(domain)?.enabled) return Infinity;
  const site = db.prepare('SELECT started,next_available_at FROM sites WHERE domain=?').get(domain);
  return site ? siteAvailableAt(now, site.started, site.next_available_at) : Infinity;
}

export function reserveSlot(db: DatabaseSync, domain: string, url: string,
  purpose: string, crawlDelay: number, clock?: number): { id?: number; due: number } {
  const ownsTransaction = !db.isTransaction;
  if (ownsTransaction) db.exec('BEGIN');
  try {
    const now = clock ?? Date.now(), configured = policy.for(domain);
    let due = slotDue(db, domain, now), id: number | undefined;
    if (configured?.enabled && due <= now) {
      const site = db.prepare('SELECT started FROM sites WHERE domain=?').get(domain)!;
      const spacing = Math.ceil(siteRules.windowMs / currentRequestLimit(now, site.started, configured.requestsPerMinute)) + siteRules.spacingMarginMs;
      const delay = Math.max(0,crawlDelay * 1000) + siteRules.spacingMarginMs;
      const origin = new URL(url).origin;
      const previous = db.prepare('SELECT last_started,next_available_at FROM budget_origins WHERE origin=?').get(origin);
      due = previous ? Math.max(due,previous.next_available_at,previous.last_started+delay) : due;
      if (due <= now) {
        const until = siteAvailableAt(now,site.started,now+siteRules.inFlightReserveMs+spacing);
        // PostgreSQL rechecks the predicate after a concurrent updater commits.
        const claimed = db.prepare('UPDATE sites SET next_available_at=? WHERE domain=? AND next_available_at<=? RETURNING domain').get(until,domain,now);
        if (claimed) {
          id = Number(db.prepare('INSERT INTO requests(domain,url,purpose,started,budget_spacing_ms,budget_delay_ms) VALUES (?,?,?,?,?,?)')
            .run(domain,url,purpose,now,spacing,delay).lastInsertRowid);
          db.prepare(`INSERT INTO budget_origins(origin,last_started,next_available_at) VALUES (?,?,?)
            ON CONFLICT(origin) DO UPDATE SET last_started=excluded.last_started,next_available_at=excluded.next_available_at`)
            .run(origin,now+siteRules.inFlightReserveMs,now+siteRules.inFlightReserveMs+delay);
        } else due = slotDue(db,domain,now);
      }
    }
    if (ownsTransaction) db.exec('COMMIT');
    return {id,due};
  } catch (error) { if (ownsTransaction) db.exec('ROLLBACK'); throw error; }
}

// Caller holds the assignment row lock. Duplicate/expired completions never get here.
export function completeSlot(db: DatabaseSync, requestId: number, sentAt: number | null, now: number, retryUntil = 0) {
  const request = db.prepare('SELECT domain,url,budget_spacing_ms,budget_delay_ms FROM requests WHERE id=?').get(requestId)!;
  const site = db.prepare('SELECT started,next_available_at FROM sites WHERE domain=? FOR UPDATE').get(request.domain)!;
  // Legacy or uncertain receipts cannot release the conservative reservation.
  const next = sentAt !== null && request.budget_spacing_ms != null
    ? siteAvailableAt(now,site.started,Math.max(sentAt+request.budget_spacing_ms,now)) : site.next_available_at;
  db.prepare('UPDATE sites SET next_available_at=? WHERE domain=?').run(Math.max(next,retryUntil),request.domain);
  // Compatibility mirror lets the previous release honor new Retry-After values on rollback.
  if (retryUntil) db.prepare('UPDATE sites SET cooldown=greatest(cooldown,?) WHERE domain=?').run(retryUntil,request.domain);
  db.prepare('UPDATE requests SET sent_at=? WHERE id=?').run(sentAt,requestId);
  if (sentAt !== null && request.budget_delay_ms != null)
    db.prepare('UPDATE budget_origins SET last_started=?,next_available_at=? WHERE origin=?')
      .run(sentAt,Math.max(now,sentAt+request.budget_delay_ms),new URL(request.url).origin);
}
