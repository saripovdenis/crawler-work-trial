import { DatabaseSync, hasTable } from "../../pg/src/sync.js";
import { LruCache } from "../../core/src/lru.js";
import { policy } from "../../../config/site-policy.js";
import { comparisonProviders, defaultComparisonProvider } from "../../../config/comparison.js";
import { pollInterval } from "../../../config/monitor.js";
import { urlKey } from "./identity.js";
import { fetchedArticles } from "./timing.js";
import { dispatchSummary } from "./dispatch.js";
import { attachAlternateTitles, groupContentKind, isRelaxedMatch, matchSightings, type Group } from "./matching/index.js";
import { publicationTiming, summarizeFreshness } from "./freshness.js";
// The matcher lives in ./matching; these names stay importable from here.
export { matchSightings, type Group, type ProviderTiming } from "./matching/index.js";
type Row = Record<string, any>;
export const windows = { "10m": 600000, "1h": 3600000, "24h": 86400000, "7d": 604800000 };
export const ARTICLE_SELECT = `SELECT canonical_url,domain,published,classification,discovered,fetched,json_extract(payload,'$.title') title,json_extract(payload,'$.sourceUrl') source_url,json_extract(payload,'$.reprocessedAt') reprocessed_at FROM articles WHERE (?='' OR domain=?)`;
export function coverageQuery(params: URLSearchParams) {
  const window = params.get("window") || "1h", site = params.get("site") || "",
    provider = params.get("provider") || defaultComparisonProvider, matches = params.get("matches") || "all",
    page = Number(params.get("page") || 1);
  if (!Object.hasOwn(windows, window) || (site && !policy.for(site))
    || !Object.hasOwn(comparisonProviders, provider) || !["all", "matched", "unmatched"].includes(matches)
    || !Number.isInteger(page) || page < 1 || page > 1000) throw new Error("Invalid reconciliation filter");
  return { window: window as keyof typeof windows, site, provider, matches, page };
}
export function pageCoverage<T extends { groups: Group[] }>(snapshot: T, matches = "all", page = 1) {
  const filtered = snapshot.groups.filter(g => matches === "all" || (matches === "matched" ? !!g.match : !g.match));
  return { ...snapshot, matches, page, pageSize: 50, groups: filtered.slice((page - 1) * 50, page * 50),
    groupCount: filtered.length, pageCount: Math.ceil(filtered.length / 50) };
}
export class CoverageReader {
  private cached = new LruCache<string, { finished: number; value: ReturnType<CoverageReader["dataset"]> }>(32, 32*1024*1024);
  constructor(readonly monitorPath: string, readonly crawlerPath: string) {}
  get(params: URLSearchParams, now = Date.now(), includeFreshness = false) {
    const q=coverageQuery(params), key=JSON.stringify([q.window,q.site,q.provider,includeFreshness]);
    let cached=this.cached.get(key);
    if (!cached || Date.now()-cached.finished>=60000) {
      const value=this.dataset(q.window,q.site,q.provider,now,includeFreshness);
      cached={value,finished:Date.now()};
      this.cached.set(key,cached,Buffer.byteLength(JSON.stringify(value)));
    }
    return pageCoverage(cached.value,q.matches,q.page);
  }
  query(
    window: keyof typeof windows,
    site: string,
    provider: string,
    now: number,
    matches = "all",
    page = 1,
    includeFreshness = false,
  ) {
    return pageCoverage(this.dataset(window,site,provider,now,includeFreshness),matches,page);
  }
  dataset(window: keyof typeof windows, site: string, provider: string, now: number, includeFreshness = false) {
    provider ||= defaultComparisonProvider;
    if (!Object.hasOwn(comparisonProviders, provider)) throw new Error("Invalid reconciliation provider");
    const start = now - windows[window];
    const base = {
      window,
      provider,
      windowStart: start,
      windowTimestamp: "provider_published_at",
      unknownPublication: 0,
      excludedNonArticles: 0,
      excludedGroups: [] as { site: string; title: string; url: string; reason: string | null }[],
      windowEnd: now,
      generatedAt: now,
      sites: policy.all().map((s) => s.domain),
      cadenceMinutes: pollInterval / 60000,
      matches: "all",
      page: 1,
      pageSize: 50,
    };
    if (!hasTable('external_sightings'))
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
          WHERE s.provider IN ('google','exa') AND s.provider_published_at>=? AND s.provider_published_at<? AND (?='' OR s.site=?) AND (?='' OR s.provider=?) ORDER BY s.provider_published_at DESC,s.id LIMIT 50001`,
        )
        .all(includeFreshness ? Number.MIN_SAFE_INTEGER : start, now, site, site, provider, provider) as Row[];
      const unknownPublication = Number(monitor.prepare(`SELECT count(*) n FROM external_sightings
        WHERE provider IN ('google','exa') AND provider_published_at IS NULL AND last_observed_at>=? AND last_observed_at<?
        AND (?='' OR site=?) AND (?='' OR provider=?)`).get(start,now,site,site,provider,provider)!.n);
      const articles = crawler
        .prepare(
          ARTICLE_SELECT,
        )
        .all(site, site) as Row[];
      attachAlternateTitles(crawler, articles, site, start);
      const allGroups = matchSightings(rows.slice(0, 50000), fetchedArticles(crawler,articles,site,now)).filter(group => {
        if (!includeFreshness) return true;
        const published = publicationTiming(group, provider || undefined).publishedAt;
        return published !== null && published >= start && published < now;
      });
      const excludedGroups = allGroups.flatMap(g => {
        const kind = groupContentKind(g);
        return kind.kind === 'non_article' ? [{site:g.site,title:g.title,url:g.url,reason:kind.reason}] : [];
      });
      const groups = allGroups.filter(g => groupContentKind(g).kind !== 'non_article');
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
        const parsedMatched = list.filter(g => g.match && !g.unparsed).length;
        const completeMatched = list.filter(g => g.match && !g.incomplete && !g.unparsed).length;
        return {
          total: list.length,
          googleOnly: list.filter(g => g.providers.length === 1 && g.providers[0] === 'google').length,
          exaOnly: list.filter(g => g.providers.length === 1 && g.providers[0] === 'exa').length,
          shared: list.filter(g => g.providers.includes('google') && g.providers.includes('exa')).length,
          matched,
          percentage: list.length ? (matched / list.length) * 100 : null,
          fetchedMatched: matched,
          fetchedPercentage: list.length ? (matched / list.length) * 100 : null,
          parsedMatched,
          parsedPercentage: list.length ? (parsedMatched / list.length) * 100 : null,
          completeMatched,
          completePercentage: list.length ? (completeMatched / list.length) * 100 : null,
          urlMatched: list.filter((g) => g.match === "url").length,
          titleMatched: list.filter((g) => g.match === "title").length,
          // Title matches split by the original exact rule and the relaxed ones.
          exactTitleMatched: list.filter((g) => g.match_rule === "exact").length,
          relaxedTitleMatched: list.filter(isRelaxedMatch).length,
          unmatched: list.filter(
            (g) => !g.match && g.observed_at <= now - 1800000,
          ).length,
          waiting: list.filter((g) => !g.match && g.observed_at > now - 1800000)
            .length,
          incomplete: list.filter((g) => g.incomplete).length,
          unparsed: list.filter((g) => g.unparsed).length,
        };
      };
      const matrix = policy.all()
        .filter((s) => !site || s.domain === site)
        .map((s) => ({
          site: s.domain,
          ...count(groups.filter((g) => g.site === s.domain)),
          counts: Object.fromEntries(
            [provider].map((p) => [
              p,
              groups.filter(
                (g) => g.site === s.domain && g.providers.includes(p),
              ).length,
            ]),
          ),
        }));
      const providers = monitor
        .prepare(
          `SELECT p.*,(SELECT sum(quota_used) FROM provider_runs r WHERE r.provider=p.provider AND started_at>=?) used_today,(SELECT sum(quota_used) FROM provider_runs r WHERE r.provider=p.provider) used_total,(SELECT min(next_poll) FROM provider_schedule s WHERE s.provider=p.provider) next_poll,(SELECT max(finished_at) FROM provider_runs r WHERE r.provider=p.provider AND status='ok') last_success,(SELECT status FROM provider_runs r WHERE r.provider=p.provider ORDER BY id DESC LIMIT 1) last_status,(SELECT error FROM provider_runs r WHERE r.provider=p.provider ORDER BY id DESC LIMIT 1) last_error FROM provider_state p WHERE p.provider=? ORDER BY p.provider`,
        )
        .all(now - 86400000, provider) as Row[];
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
      groups.sort((a,b)=>b.observed_at-a.observed_at || a.key.localeCompare(b.key));
      return {
        ...base,
        ready: true,
        summary: count(groups),
        dispatch: dispatchSummary(crawler,now,site),
        freshness: includeFreshness ? summarizeFreshness(groups, matrix.map(r => r.site), [provider]) : undefined,
        unfilteredSummary: count(allGroups),
        unknownPublication,
        excludedNonArticles: excludedGroups.length,
        excludedGroups,
        groups: includeFreshness ? groups.map(group => ({ ...group, publication_timing: publicationTiming(group, provider || undefined) })) : groups,
        groupCount: groups.length,
        pageCount: Math.ceil(groups.length / 50),
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
