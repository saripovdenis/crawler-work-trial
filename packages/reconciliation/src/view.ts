import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { sites } from "../../../config/sites.js";
import { providerIds, pollInterval } from "../../../config/monitor.js";
import { urlKey, matchingTitle, date } from "./identity.js";
import { attachFetchTiming } from "./timing.js";
import { dispatchSummary } from "./dispatch.js";
import { externalContentKind } from "./content-kind.js";
type Row = Record<string, any>;
export type ProviderTiming = {
  sighting_id: number;
  provider: string;
  url: string;
  published_at: number | null;
  provider_first_seen_at: number | null;
  observed_at: number;
  last_observed_at: number;
  first_run_id: number;
  first_poll_started_at: number | null;
  first_poll_finished_at: number | null;
  fetch_minus_observed_ms: number | null;
  fetch_minus_published_ms: number | null;
};
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
  provider_timings: ProviderTiming[];
  crawler_source_url: string | null;
  crawler_published_at: number | null;
  crawler_discovered_at: number | null;
  crawler_parsed_at: number | null;
  crawler_reprocessed_at: number | null;
  crawler_fetch_finished_at: number | null;
  crawler_fetch_time_source:
    | "worker_receipt"
    | "legacy_request_finished"
    | null;
  crawler_request_id: number | null;
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
    const k = a.domain + "|" + matchingTitle(a.title || "", a.domain);
    const list = titles.get(k) || [];
    list.push(a);
    titles.set(k, list);
  }
  const groups = new Map<string, Group>();
  const groupTitles = new Map<string, Group[]>();
  for (const original of [...rows].sort(
    (a, b) => Number(!!b.url_key) - Number(!!a.url_key),
  )) {
    const row: Row = { ...original, url_key: urlKey(original.url_raw), title_key: matchingTitle(original.title || "", original.site) };
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
    const timing: ProviderTiming = {
      sighting_id: row.id,
      provider: row.provider,
      url: row.url_raw,
      published_at: row.provider_published_at ?? null,
      provider_first_seen_at: row.provider_first_seen_at ?? null,
      observed_at: row.observed_at,
      last_observed_at: row.last_observed_at ?? row.observed_at,
      first_run_id: row.run_id,
      first_poll_started_at: row.first_poll_started_at ?? null,
      first_poll_finished_at: row.first_poll_finished_at ?? null,
      fetch_minus_observed_ms: null,
      fetch_minus_published_ms: null,
    };
    if (current) {
      current.provider_timings.push(timing);
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
      provider_timings: [timing],
      crawler_source_url: article?.source_url || null,
      crawler_published_at: date(article?.published),
      crawler_discovered_at: article?.discovered ?? null,
      crawler_parsed_at: article?.fetched ?? null,
      crawler_reprocessed_at: date(article?.reprocessed_at),
      crawler_fetch_finished_at: null,
      crawler_fetch_time_source: null,
      crawler_request_id: null,
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
    const window = params.get("window") || "1h",
      site = params.get("site") || "",
      provider = params.get("provider") || "",
      matches = params.get("matches") || "all",
      page = Number(params.get("page") || 1);
    if (
      !Object.hasOwn(windows, window) ||
      (site && !sites.some((s) => s.domain === site)) ||
      (provider && !providerIds.includes(provider as any)) ||
      !["all", "matched", "unmatched"].includes(matches) ||
      !Number.isInteger(page) ||
      page < 1 ||
      page > 1000
    )
      throw new Error("Invalid reconciliation filter");
    const key = JSON.stringify([window, site, provider, matches, page]);
    const cached = this.cached.get(key);
    if (cached && now - cached.at < 15000) return cached.value;
    const value = this.query(
      window as keyof typeof windows,
      site,
      provider,
      now,
      matches,
      page,
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
    matches = "all",
    page = 1,
  ) {
    const start = now - windows[window];
    const base = {
      window,
      windowStart: start,
      windowTimestamp: "provider_published_at",
      unknownPublication: 0,
      excludedNonArticles: 0,
      excludedGroups: [] as { site: string; title: string; url: string; reason: string | null }[],
      windowEnd: now,
      generatedAt: now,
      sites: sites.map((s) => s.domain),
      cadenceMinutes: pollInterval / 60000,
      matches,
      page,
      pageSize: 50,
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
        groupCount: 0,
        pageCount: 0,
      };
    const monitor = new DatabaseSync(this.monitorPath, { readOnly: true }),
      crawler = new DatabaseSync(this.crawlerPath, { readOnly: true });
    try {
      monitor.exec("PRAGMA query_only=ON;PRAGMA busy_timeout=2000");
      crawler.exec("PRAGMA query_only=ON;PRAGMA busy_timeout=2000");
      const rows = monitor
        .prepare(
          `SELECT s.*,r.started_at first_poll_started_at,r.finished_at first_poll_finished_at
          FROM external_sightings s LEFT JOIN provider_runs r ON r.id=s.run_id
          WHERE s.provider IN ('google','exa') AND s.provider_published_at>=? AND s.provider_published_at<? AND (?='' OR s.site=?) AND (?='' OR s.provider=?) ORDER BY s.provider_published_at DESC LIMIT 50001`,
        )
        .all(start, now, site, site, provider, provider) as Row[];
      const unknownPublication = Number(monitor.prepare(`SELECT count(*) n FROM external_sightings
        WHERE provider IN ('google','exa') AND provider_published_at IS NULL AND last_observed_at>=? AND last_observed_at<?
        AND (?='' OR site=?) AND (?='' OR provider=?)`).get(start,now,site,site,provider,provider)!.n);
      const articles = crawler
        .prepare(
          `SELECT canonical_url,domain,published,classification,discovered,fetched,json_extract(payload,'$.title') title,json_extract(payload,'$.sourceUrl') source_url,json_extract(payload,'$.reprocessedAt') reprocessed_at FROM articles WHERE (?='' OR domain=?)`,
        )
        .all(site, site) as Row[];
      const allGroups = matchSightings(rows.slice(0, 50000), articles);
      const excludedGroups = allGroups.flatMap(g => {
        const kind = externalContentKind(g.url, g.site);
        return kind.kind === 'non_article' ? [{site:g.site,title:g.title,url:g.url,reason:kind.reason}] : [];
      });
      const groups = allGroups.filter(g => externalContentKind(g.url, g.site).kind !== 'non_article');
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
          LEFT JOIN (SELECT task_id,max(request_id) request_id FROM attempt_assignments GROUP BY task_id) a ON a.task_id=t.id
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
        const completeMatched = list.filter(g => g.match && !g.incomplete).length;
        return {
          total: list.length,
          googleOnly: list.filter(g => g.providers.length === 1 && g.providers[0] === 'google').length,
          exaOnly: list.filter(g => g.providers.length === 1 && g.providers[0] === 'exa').length,
          shared: list.filter(g => g.providers.includes('google') && g.providers.includes('exa')).length,
          matched,
          percentage: list.length ? (matched / list.length) * 100 : null,
          completeMatched,
          completePercentage: list.length ? (completeMatched / list.length) * 100 : null,
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
          `SELECT p.*,(SELECT sum(quota_used) FROM provider_runs r WHERE r.provider=p.provider AND started_at>=?) used_today,(SELECT sum(quota_used) FROM provider_runs r WHERE r.provider=p.provider) used_total,(SELECT min(next_poll) FROM provider_schedule s WHERE s.provider=p.provider) next_poll,(SELECT max(finished_at) FROM provider_runs r WHERE r.provider=p.provider AND status='ok') last_success,(SELECT status FROM provider_runs r WHERE r.provider=p.provider ORDER BY id DESC LIMIT 1) last_status,(SELECT error FROM provider_runs r WHERE r.provider=p.provider ORDER BY id DESC LIMIT 1) last_error FROM provider_state p WHERE p.provider IN ('google','exa')`,
        )
        .all(now - 86400000) as Row[];
      for (const p of providers) {
        p.quota_exhausted =
          (p.used_today || 0) >= p.daily_limit ||
          (p.total_limit > 0 && (p.used_total || 0) >= p.total_limit);
      }
      const runs = monitor
        .prepare(
          `SELECT * FROM provider_runs WHERE provider IN ('google','exa') AND (?='' OR site=?) AND (?='' OR provider=?) ORDER BY id DESC LIMIT 100`,
        )
        .all(site, site, provider, provider) as Row[];
      const truncated =
        rows.length > 50000 ||
        !!monitor
          .prepare(
            `SELECT 1 FROM provider_runs WHERE provider IN ('google','exa') AND started_at>=? AND truncated=1 AND (?='' OR site=?) AND (?='' OR provider=?) LIMIT 1`,
          )
          .get(start, site, site, provider, provider);
      const heartbeat = monitor
        .prepare("SELECT value FROM monitor_meta WHERE key='heartbeat'")
        .get()?.value;
      const filtered = groups
        .filter(
          (g) =>
            matches === "all" || (matches === "matched" ? !!g.match : !g.match),
        )
        .sort(
          (a, b) => b.observed_at - a.observed_at || a.key.localeCompare(b.key),
        );
      const displayed = filtered.slice((page - 1) * 50, page * 50);
      attachFetchTiming(crawler, displayed);
      return {
        ...base,
        ready: true,
        summary: count(groups),
        dispatch: dispatchSummary(crawler,now,site),
        unfilteredSummary: count(allGroups),
        unknownPublication,
        excludedNonArticles: excludedGroups.length,
        excludedGroups,
        groups: displayed,
        groupCount: filtered.length,
        pageCount: Math.ceil(filtered.length / 50),
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
