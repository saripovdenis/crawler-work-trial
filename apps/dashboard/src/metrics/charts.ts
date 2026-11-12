import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { sites } from '../../../../config/sites.js';

export const chartWindows = { '5m': 300_000, '30m': 1800_000, '1h': 3600_000, '3h': 10800_000, '1d': 86400_000, '1w': 604800_000 } as const;
type Window = keyof typeof chartWindows;
type Counts = { domain: string; total: number; incomplete: number };
export class Charts {
  readonly db: DatabaseSync;
  private cache = new Map<Window, { at: number; value: ReturnType<Charts['query']> }>();
  constructor(directory: string) {
    this.db = new DatabaseSync(resolve(directory, 'crawler.sqlite'), { readOnly: true });
    this.db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=2000');
  }
  parsingQuality(params: URLSearchParams, now = Date.now()) {
    const key = params.get('window') ?? '1h';
    if (!Object.hasOwn(chartWindows, key)) throw new Error('Invalid chart window');
    const window = key as Window;
    const cached = this.cache.get(window);
    if (cached && now >= cached.at && now - cached.at < 10_000) return cached.value;
    const value = this.query(window, now);
    this.cache.set(window, { at: now, value });
    return value;
  }
  private query(window: Window, end: number) {
    const start = end - chartWindows[window];
    // Reuse persisted classification from policy.classify. Never reclassify here.
    // fetched is written by worker.fetchArticle after parseArticle completes.
    const rows = this.db.prepare(`SELECT domain,count(*) total,
      sum(classification='incomplete') incomplete FROM articles
      WHERE fetched>=? AND fetched<? GROUP BY domain`).all(start, end) as Counts[];
    const domains = sites.map(({ domain }) => {
      const row = rows.find(r => r.domain === domain) ?? { domain, total: 0, incomplete: 0 };
      return { ...row, percentage: row.total ? row.incomplete / row.total * 100 : null };
    }).sort((a, b) => (b.percentage ?? -1) - (a.percentage ?? -1) || a.domain.localeCompare(b.domain));
    const total = domains.reduce((n, r) => n + r.total, 0);
    const incomplete = domains.reduce((n, r) => n + r.incomplete, 0);
    return { window, windowStart: new Date(start).toISOString(), windowEnd: new Date(end).toISOString(),
      overall: { total, incomplete, percentage: total ? incomplete / total * 100 : null }, domains };
  }
}
