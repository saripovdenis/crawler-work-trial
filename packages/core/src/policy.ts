import { policy, siteRules } from '../../../config/site-policy.js';
import { listingRoutes } from '../../../config/article-rules.js';

export function domainFor(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || (u.port && !['80', '443'].includes(u.port))) return;
    // Paused domains remain recognizable for archived responses and history.
    return policy.all().find(s => u.hostname === s.domain || u.hostname.endsWith(`.${s.domain}`))?.domain;
  } catch { return; }
}

// Verified publisher category/directory routes, never individual articles.
// Keep this narrow: unrecognized routes still receive normal discovery/parsing.
export function isKnownListingUrl(url: string): boolean {
  const domain = domainFor(url);
  return !!domain && !!listingRoutes[domain]?.test(new URL(url).pathname);
}

export function normalizeUrl(value: string, base?: string): string | undefined {
  try {
    const u = new URL(value, base);
    if (!domainFor(u.href)) return;
    u.hash = '';
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$)/i.test(key)) u.searchParams.delete(key);
    }
    return u.href;
  } catch { return; }
}

// Recent times are persisted BEFORE dispatch, including failures and redirect hops.
// At the setup boundary, also enforce the steady-state rolling window conservatively.
export function nextAllowed(now: number, started: number, rpm: number, recent: number[], crawlDelay = 0): number {
  const limit = currentRequestLimit(now, started, rpm);
  const spacing = Math.max(Math.ceil(siteRules.windowMs / limit), crawlDelay * 1000) + siteRules.spacingMarginMs;
  let due = now;
  const last = recent.at(-1);
  if (last !== undefined) due = Math.max(due, last + spacing);
  const window = recent.filter(t => t > now - siteRules.windowMs);
  if (window.length >= limit) due = Math.max(due, window[window.length - limit] + siteRules.windowMs + siteRules.spacingMarginMs);
  return due;
}

export function currentRequestLimit(now: number, started: number, rpm: number): number {
  return now < started + siteRules.warmupMs ? siteRules.warmupRequestsPerMinute : rpm;
}

// Shared by the scheduler and dashboard. Requests must be ordered by start time.
export function budgetDue(now: number, started: number, rpm: number,
  recent: readonly { started: number; finished: number | null }[], cooldown = 0, crawlDelay = 0): number {
  let due = Math.max(cooldown, nextAllowed(now, started, rpm, recent.map(r => r.started), crawlDelay));
  if (recent.length) {
    const lastPossibleDispatch = Math.max(...recent.map(r => r.finished ?? r.started + siteRules.inFlightReserveMs));
    due = Math.max(due, nextAllowed(now, started, rpm, [lastPossibleDispatch], crawlDelay));
  }
  return due;
}

// Missing timezone is not guessed from this laptop's timezone.
export function dateIso(value: unknown): string | null {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d\d:?\d\d|GMT|UTC)\s*$/i.test(value.trim())) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function classify(published: string | null, started: number, discovered: number, duplicate: boolean, valid: boolean) {
  if (!valid) return 'incomplete';
  if (duplicate) return 'duplicate';
  if (!published) return 'unknown_date';
  const time = Date.parse(published);
  if (time > discovered) return 'future_date';
  return time >= started ? 'new' : 'old';
}
