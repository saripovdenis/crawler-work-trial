// Ties the external sample to fetched articles. Everything that decides
// whether a sample row counts as matched, or is left out as a non-article,
// lives in this folder:
//   rules.ts         thresholds and on/off switches
//   titles.ts        the title forms that are compared
//   title-index.ts   the title rules, in the order they are tried
//   content-kind.ts  page shapes that are not articles
// The readers (view.ts, crawler-only.ts) only call matchSightings,
// attachAlternateTitles and groupContentKind.
import type { DatabaseSync } from '../../../pg/src/sync.js';
import { urlKey, matchingTitle, date } from '../identity.js';
import { matchingRules, relaxedRules, type MatchRule } from './rules.js';
import { TitleIndex } from './title-index.js';

export { matchingRules, relaxedRules, type MatchRule } from './rules.js';
export { externalContentKind, groupContentKind, type ExternalContentKind } from './content-kind.js';

type Row = Record<string, any>;
export type ProviderTiming = {
  sighting_id: number;
  provider: string;
  url: string;
  source_host: string | null;
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
  // Which rule produced the match; 'exact' is the original title rule.
  match_rule: MatchRule | null;
  article_url: string | null;
  incomplete: boolean;
  unparsed: boolean;
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

// Some publishers give a page two titles: the headline, which the parser
// stores, and og:title, which a provider may show instead. Only articles that
// can still match the window are read, so the extra JSON work stays bounded.
const ALTERNATE_TITLE_SELECT = `SELECT canonical_url,json_extract(payload,'$.socialTags.og:title.0') alt_title
  FROM articles WHERE fetched>=? AND (?='' OR domain=?)`;
export function attachAlternateTitles(crawler: DatabaseSync, articles: Row[], site: string, windowStart: number) {
  if (!matchingRules.enabled.alternateTitle) return;
  const titles = new Map<string, string>();
  for (const row of crawler.prepare(ALTERNATE_TITLE_SELECT).all(windowStart - matchingRules.relaxedWindowMs, site, site) as Row[])
    if (row.alt_title) titles.set(row.canonical_url, row.alt_title);
  for (const article of articles) {
    const title = titles.get(article.canonical_url);
    if (title) article.alt_title = title;
  }
}

export function matchSightings(rows: Row[], articles: Row[]): Group[] {
  const urls = new Map<string, Row>();
  for (const a of articles) {
    for (const raw of [a.canonical_url, a.source_url, ...(a.match_urls || [])]) {
      const k = raw && urlKey(raw);
      if (k) urls.set(k, a);
    }
  }
  let from = Infinity, to = -Infinity;
  for (const row of rows) {
    if (row.provider_published_at === null || row.provider_published_at === undefined) continue;
    from = Math.min(from, row.provider_published_at);
    to = Math.max(to, row.provider_published_at);
  }
  const titles = new TitleIndex(articles, from - matchingRules.relaxedWindowMs, to + matchingRules.relaxedWindowMs);
  const groups = new Map<string, Group>();
  const groupTitles = new Map<string, Group[]>();
  for (const original of [...rows].sort(
    (a, b) => Number(!!b.url_key) - Number(!!a.url_key),
  )) {
    const row: Row = { ...original, url_key: urlKey(original.url_raw), title_key: matchingTitle(original.title || "", original.site) };
    let article = row.url_key ? urls.get(row.url_key) : undefined;
    let rule: MatchRule | null = article ? "url" : null;
    let ambiguous = false;
    if (!article && row.provider_published_at !== null) {
      const found = titles.find(row.site, row.title || "", row.provider_published_at);
      if (found && "article" in found) {
        article = found.article;
        rule = found.rule;
      } else ambiguous = !!found;
    }
    const kind: Group["match"] = rule === "url" ? "url" : rule ? "title" : null;
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
      if (same.length === 1) key = same[0]!.key;
    }
    const current = groups.get(key);
    const timing: ProviderTiming = {
      sighting_id: row.id,
      provider: row.provider,
      url: row.url_raw,
      source_host: row.source_host ?? null,
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
      if (kind === "url") {
        current.match = "url";
        current.match_rule = "url";
      }
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
      match_rule: rule,
      article_url: article?.canonical_url || null,
      incomplete: article?.classification === "incomplete",
      unparsed: !!article && article.fetched == null,
      ambiguous,
      provider_timings: [timing],
      crawler_source_url: article?.source_url || null,
      crawler_published_at: date(article?.published),
      crawler_discovered_at: article?.discovered ?? null,
      crawler_parsed_at: article?.fetched ?? null,
      crawler_reprocessed_at: date(article?.reprocessed_at),
      crawler_fetch_finished_at: article?.fetch_finished_at ?? null,
      crawler_fetch_time_source: article?.fetch_time_source ?? null,
      crawler_request_id: article?.request_id ?? null,
    };
    groups.set(key, group);
    const titleGroupKey = row.site + "|" + row.title_key;
    const titleGroups = groupTitles.get(titleGroupKey) || [];
    titleGroups.push(group);
    groupTitles.set(titleGroupKey, titleGroups);
  }
  for (const group of groups.values()) {
    const finished = group.crawler_fetch_finished_at;
    if (finished === null) continue;
    for (const timing of group.provider_timings) {
      timing.fetch_minus_observed_ms = finished - timing.observed_at;
      timing.fetch_minus_published_ms = timing.published_at === null ? null : finished - timing.published_at;
    }
  }
  return [...groups.values()];
}

// Title matches made by a rule other than the original exact one.
export const isRelaxedMatch = (group: Group) => !!group.match_rule && relaxedRules.includes(group.match_rule);
