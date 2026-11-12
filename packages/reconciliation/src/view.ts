import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { sites } from "../../../config/sites.js";
import { providerIds } from "../../../config/monitor.js";
import { urlKey, titleKey } from "./identity.js";
type Row = Record<string, any>;
export type Group = {
  key: string;
  site: string;
  title: string;
  url: string;
  url_key: string | null;
  observed_at: number;
  published_at: number | null;
  providers: string[];
  match: "url" | "title" | null;
  article_url: string | null;
  incomplete: boolean;
  ambiguous: boolean;
  audit?: { state: string; status: number | null; error: string | null };
};
export function matchSightings(rows: Row[], articles: Row[]): Group[] {
  const urls = new Map<string, Row>();
  const titles = new Map<string, Row[]>();
  for (const a of articles) {
    for (const raw of [a.canonical_url, a.source_url]) {
      const k = raw && urlKey(raw);
      if (k) urls.set(k, a);
    }
    const k = a.domain + "|" + titleKey(a.title || "");
    const list = titles.get(k) || [];
    list.push(a);
    titles.set(k, list);
  }
  const groups = new Map<string, Group>();
  const groupTitles = new Map<string, Group[]>();
  for (const row of [...rows].sort(
    (a, b) => Number(!!b.url_key) - Number(!!a.url_key),
  )) {
    let article = row.url_key ? urls.get(row.url_key) : undefined;
    let kind: Group["match"] = article ? "url" : null;
    let ambiguous = false;
    if (
      !article &&
      row.title_key.length >= 12 &&
      row.provider_published_at !== null
    ) {
      const candidates = (
        titles.get(row.site + "|" + row.title_key) || []
      ).filter(
        (a) =>
          a.published &&
          Math.abs(Date.parse(a.published) - row.provider_published_at) <=
            6 * 3600000,
      );
      if (candidates.length === 1) {
        article = candidates[0];
        kind = "title";
      } else ambiguous = candidates.length > 1;
    }
    let key = article
      ? "article:" + article.canonical_url
      : row.url_key
        ? "url:" + row.url_key
        : `title:${row.site}:${row.title_key}:${row.provider_published_at ?? row.url_raw}`;
    if (!article && !row.url_key && row.provider_published_at !== null) {
      const same = (
        groupTitles.get(row.site + "|" + row.title_key) || []
      ).filter(
        (g) =>
          g.published_at !== null &&
          Math.abs(g.published_at - row.provider_published_at) <= 6 * 3600000,
      );
      if (same.length === 1) key = same[0].key;
    }
    const current = groups.get(key);
    if (current) {
      if (!current.providers.includes(row.provider))
        current.providers.push(row.provider);
      current.observed_at = Math.min(current.observed_at, row.observed_at);
      if (kind === "url") current.match = "url";
      continue;
    }
    const group: Group = {
      key,
      site: row.site,
      title: row.title,
      url: row.url_raw,
      url_key: row.url_key,
      observed_at: row.observed_at,
      published_at: row.provider_published_at,
      providers: [row.provider],
      match: kind,
      article_url: article?.canonical_url || null,
      incomplete: article?.classification === "incomplete",
      ambiguous,
    };
    groups.set(key, group);
    const titleGroupKey = row.site + "|" + row.title_key;
    const titleGroups = groupTitles.get(titleGroupKey) || [];
    titleGroups.push(group);
    groupTitles.set(titleGroupKey, titleGroups);
  }
  return [...groups.values()];
}
const windows = { "1h": 3600000, "24h": 86400000, "7d": 604800000 };
export class CoverageReader {
  private cached = new Map<
    string,
    { at: number; value: ReturnType<CoverageReader["query"]> }
  >();
  constructor(
    readonly monitorPath: string,
    readonly crawlerPath: string,
  ) {}
  get(params: URLSearchParams, now = Date.now()) {
    const window = params.get("window") || "24h",
      site = params.get("site") || "",
      provider = params.get("provider") || "";
    if (
      !Object.hasOwn(windows, window) ||
      (site && !sites.some((s) => s.domain === site)) ||
      (provider && !providerIds.includes(provider as any))
    )
      throw new Error("Invalid reconciliation filter");
    const key = JSON.stringify([window, site, provider]);
    const cached = this.cached.get(key);
    if (cached && now - cached.at < 15000) return cached.value;
    const value = this.query(
      window as keyof typeof windows,
      site,
      provider,
      now,
    );
    if (this.cached.size > 100) this.cached.clear();
    this.cached.set(key, { at: now, value });
    return value;
  }
  query(
    window: keyof typeof windows,
    site: string,
    provider: string,
    now: number,
  ) {
    const start = now - windows[window];
    const base = {
      window,
      windowStart: start,
      windowEnd: now,
      generatedAt: now,
      sites: sites.map((s) => s.domain),
      cadenceMinutes: 30,
    };
    if (!existsSync(this.monitorPath))
      return {
        ...base,
        ready: false,
        summary: null,
        groups: [] as Group[],
        matrix: [] as Row[],
        providers: [] as Row[],
        runs: [] as Row[],
        truncated: false,
        heartbeat: null,
      };
    const monitor = new DatabaseSync(this.monitorPath, { readOnly: true }),
      crawler = new DatabaseSync(this.crawlerPath, { readOnly: true });
    try {
      monitor.exec("PRAGMA query_only=ON;PRAGMA busy_timeout=2000");
      crawler.exec("PRAGMA query_only=ON;PRAGMA busy_timeout=2000");
      const rows = monitor
        .prepare(
          `SELECT * FROM external_sightings WHERE observed_at>=? AND observed_at<? AND (?='' OR site=?) AND (?='' OR provider=?) ORDER BY observed_at DESC LIMIT 50001`,
        )
        .all(start, now, site, site, provider, provider) as Row[];
      const articles = crawler
        .prepare(
          `SELECT canonical_url,domain,published,classification,json_extract(payload,'$.title') title,json_extract(payload,'$.sourceUrl') source_url FROM articles WHERE (?='' OR domain=?)`,
        )
        .all(site, site) as Row[];
      const groups = matchSightings(rows.slice(0, 50000), articles);
      if (
        crawler
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE name='attempt_assignments'",
          )
          .get()
      ) {
        const audits = crawler
          .prepare(
            `SELECT t.url,t.state,r.status,r.error FROM crawl_tasks t
          LEFT JOIN attempt_assignments a ON a.request_id=(SELECT max(request_id) FROM attempt_assignments WHERE task_id=t.id)
          LEFT JOIN requests r ON r.id=a.request_id WHERE t.purpose='audit'`,
          )
          .all() as Row[];
        const byUrl = new Map(audits.map((a) => [urlKey(a.url), a]));
        for (const group of groups) {
          const audit = byUrl.get(group.url_key);
          if (audit)
            group.audit = {
              state: audit.state,
              status: audit.status,
              error: audit.error,
            };
        }
      }
      const count = (list: Group[]) => {
        const matched = list.filter((g) => g.match).length;
        return {
          total: list.length,
          matched,
          percentage: list.length ? (matched / list.length) * 100 : null,
          urlMatched: list.filter((g) => g.match === "url").length,
          titleMatched: list.filter((g) => g.match === "title").length,
          unmatched: list.filter(
            (g) => !g.match && g.observed_at <= now - 1800000,
          ).length,
          waiting: list.filter((g) => !g.match && g.observed_at > now - 1800000)
            .length,
          incomplete: list.filter((g) => g.incomplete).length,
        };
      };
      const matrix = sites
        .filter((s) => !site || s.domain === site)
        .map((s) => ({
          site: s.domain,
          ...count(groups.filter((g) => g.site === s.domain)),
          counts: Object.fromEntries(
            providerIds.map((p) => [
              p,
              groups.filter(
                (g) => g.site === s.domain && g.providers.includes(p),
              ).length,
            ]),
          ),
        }));
      const providers = monitor
        .prepare(
          `SELECT p.*,(SELECT sum(quota_used) FROM provider_runs r WHERE r.provider=p.provider AND started_at>=?) used_today,(SELECT sum(quota_used) FROM provider_runs r WHERE r.provider=p.provider) used_total,(SELECT min(next_poll) FROM provider_schedule s WHERE s.provider=p.provider) next_poll,(SELECT max(finished_at) FROM provider_runs r WHERE r.provider=p.provider AND status='ok') last_success,(SELECT status FROM provider_runs r WHERE r.provider=p.provider ORDER BY id DESC LIMIT 1) last_status,(SELECT error FROM provider_runs r WHERE r.provider=p.provider ORDER BY id DESC LIMIT 1) last_error FROM provider_state p`,
        )
        .all(now - 86400000) as Row[];
      for (const p of providers) {
        p.quota_exhausted =
          (p.used_today || 0) >= p.daily_limit ||
          (p.total_limit > 0 && (p.used_total || 0) >= p.total_limit);
      }
      const runs = monitor
        .prepare(
          `SELECT * FROM provider_runs WHERE (?='' OR site=?) AND (?='' OR provider=?) ORDER BY id DESC LIMIT 100`,
        )
        .all(site, site, provider, provider) as Row[];
      const truncated =
        rows.length > 50000 ||
        !!monitor
          .prepare(
            `SELECT 1 FROM provider_runs WHERE started_at>=? AND truncated=1 AND (?='' OR site=?) AND (?='' OR provider=?) LIMIT 1`,
          )
          .get(start, site, site, provider, provider);
      const heartbeat = monitor
        .prepare("SELECT value FROM monitor_meta WHERE key='heartbeat'")
        .get()?.value;
      return {
        ...base,
        ready: true,
        summary: count(groups),
        groups: groups
          .sort(
            (a, b) =>
              Number(!!a.match) - Number(!!b.match) ||
              b.observed_at - a.observed_at,
          )
          .slice(0, 200),
        matrix,
        providers,
        runs,
        truncated,
        heartbeat: heartbeat ? Number(heartbeat) : null,
      };
    } finally {
      monitor.close();
      crawler.close();
    }
  }
}
