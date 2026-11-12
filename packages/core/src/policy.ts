import { sites, setup } from '../../../config/sites.js';

export function domainFor(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || (u.port && !['80', '443'].includes(u.port))) return;
    return sites.find(s => u.hostname === s.domain || u.hostname.endsWith(`.${s.domain}`))?.domain;
  } catch { return; }
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
  const setupActive = now < started + setup.durationSeconds * 1000;
  const limit = setupActive ? 60 : rpm;
  const spacing = Math.max(setupActive ? 1000 : Math.ceil(60_000 / rpm), crawlDelay * 1000) + 20;
  let due = now;
  const last = recent.at(-1);
  if (last !== undefined) due = Math.max(due, last + spacing);
  const window = recent.filter(t => t > now - 60_000);
  if (window.length >= limit) due = Math.max(due, window[window.length - limit] + 60_020);
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
