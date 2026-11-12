import type { DatabaseSync } from 'node:sqlite';
import { nextAllowed } from '../../../../packages/core/src/policy.js';

// Transport deadlines are <=25s. An unfinished reservation remains charged after
// a crash; allow 30s for a possible in-flight request before starting the spacing.
const IN_FLIGHT_MS = 30_000;

// Read-only eligibility check; reserveSlot repeats it inside the write transaction.
export function slotDue(db: DatabaseSync, domain: string, rpm: number, crawlDelay: number, now: number): number {
  const site = db.prepare('SELECT started,cooldown FROM sites WHERE domain=?').get(domain) as { started: number; cooldown: number } | undefined;
  if (!site) throw new Error(`Site not initialized: ${domain}`);
  const recent = (db.prepare('SELECT started,finished FROM requests WHERE domain=? ORDER BY started DESC,id DESC LIMIT 61').all(domain) as { started: number; finished: number | null }[]).reverse();
  let due = Math.max(site.cooldown, nextAllowed(now, site.started, rpm, recent.map(r => r.started), crawlDelay));
  if (recent.length) {
    const lastPossibleDispatch = Math.max(...recent.map(r => r.finished ?? r.started + IN_FLIGHT_MS));
    due = Math.max(due, nextAllowed(now, site.started, rpm, [lastPossibleDispatch], crawlDelay));
  }
  return due;
}

export function reserveSlot(db: DatabaseSync, domain: string, url: string,
  purpose: string, rpm: number, crawlDelay: number, clock?: number): { id?: number; due: number } {
  const ownsTransaction = !db.isTransaction;
  if (ownsTransaction) db.exec('BEGIN IMMEDIATE');
  try {
    const now = clock ?? Date.now();
    const due = slotDue(db, domain, rpm, crawlDelay, now);
    const id = due <= now ? Number(db.prepare('INSERT INTO requests(domain,url,purpose,started) VALUES (?,?,?,?)').run(domain, url, purpose, now).lastInsertRowid) : undefined;
    if (ownsTransaction) db.exec('COMMIT');
    return { id, due };
  } catch (error) { if (ownsTransaction) db.exec('ROLLBACK'); throw error; }
}
