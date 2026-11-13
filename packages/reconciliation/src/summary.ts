import { percentiles, publicationTiming } from "./freshness.js";
import type { Group } from "./matching/index.js";

// The dashboard's Coverage and Freshness pages show these windows side by side.
export const summaryWindows = { "10m": 600000, "1h": 3600000, "24h": 86400000 } as const;
type Row = Record<string, any>;

/**
 * Derives every summary window from one 24-hour coverage dataset, so the pages
 * cost one query instead of one per window. A group belongs to a window by its
 * earliest provider publication time; the 24-hour figures equal
 * `/api/reconciliation?window=24h`.
 */
export function windowSummary(dataset: Row, provider: string) {
  const now: number = dataset.windowEnd;
  const timed = (dataset.groups as Group[]).map(group => ({ group, timing: publicationTiming(group, provider) }));
  const stats = (list: typeof timed) => {
    const matched = list.filter(({ group }) => group.match).length;
    const delays = list.flatMap(({ timing }) => timing.delayMs === null ? [] : [timing.delayMs]);
    return {
      total: list.length,
      matched,
      coverage: list.length ? (matched / list.length) * 100 : null,
      freshness: percentiles(delays),
    };
  };
  const p = (dataset.providers as Row[] | undefined)?.[0];
  return {
    generatedAt: dataset.generatedAt,
    ready: !!dataset.ready,
    provider,
    cadenceMinutes: dataset.cadenceMinutes,
    heartbeat: dataset.heartbeat ?? null,
    truncated: !!dataset.truncated,
    dispatchFailures: dataset.dispatch?.deadlineFailures ?? 0,
    providerState: p ? {
      enabled: !!p.enabled, quotaExhausted: !!p.quota_exhausted,
      lastError: p.last_error ?? null, note: p.note ?? null,
    } : null,
    windows: Object.entries(summaryWindows).map(([window, ms]) => {
      const inWindow = timed.filter(({ timing }) =>
        timing.publishedAt !== null && timing.publishedAt >= now - ms && timing.publishedAt < now);
      return {
        window,
        ...stats(inWindow),
        domains: (dataset.sites as string[]).map(site => ({ site, ...stats(inWindow.filter(({ group }) => group.site === site)) })),
      };
    }),
  };
}
