import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { sites } from '../../../config/sites.js';
import { pollInterval, pollLookback, providerIds, type ProviderId } from '../../../config/monitor.js';
import { ARTICLE_SELECT, matchSightings, windows } from './view.js';
import { fetchedArticles } from './timing.js';
import { date, matchingTitle, urlKey } from './identity.js';

type Row = Record<string, any>;
export type CrawlerOnlyStatus = 'listed' | 'pending' | 'possible' | 'strong' | 'weak' | 'not_comparable';
export type CrawlerOnlyWindow = '1h' | '24h' | '7d';
export type CrawlerOnlyProvider = 'both' | ProviderId;
export type CrawlerOnlyShow = CrawlerOnlyStatus | 'all' | 'crawler_only';
const statuses: CrawlerOnlyShow[] = ['all','crawler_only','listed','pending','possible','strong','weak','not_comparable'];
const rowLimit = 2000;
const gracePeriod = pollLookback + pollInterval;
const providerNames = { google: 'Google News', exa: 'Exa' };

export type StatusCounts = {
  total: number; comparable: number; listed: number; googleOnly: number; exaOnly: number; both: number;
  possible: number; strong: number; weak: number; pending: number; notComparable: number; crawlerOnly: number;
};
type Poll = { id: number; startedAt: number; windowStart: number; windowEnd: number; truncated: boolean };
export type ProviderEvidence = {
  status: CrawlerOnlyStatus; reason: string; match: 'url' | 'title' | null; poll: Poll | null;
};
export type CrawlerOnlyArticle = {
  url: string; title: string; site: string; publishedAt: number; parsedAt: number;
  fetchFinishedAt: number | null; requestId: number | null; status: CrawlerOnlyStatus;
  incomplete: boolean; google: ProviderEvidence; exa: ProviderEvidence;
};
type PollCounts = { successful: number; capped: number; percentage: number | null; failed: number };
export type CrawlerOnlySnapshot = {
  window: CrawlerOnlyWindow; windowStart: number; windowEnd: number; generatedAt: number;
  windowTimestamp: 'article_published_at'; sites: string[]; provider: CrawlerOnlyProvider;
  selectedProviders: readonly ProviderId[]; summary: StatusCounts;
  domains: (StatusCounts & { site: string; polls: Record<ProviderId, PollCounts> })[];
  articles: CrawlerOnlyArticle[]; rowsLimit: number; rowsTruncated: boolean; totalRows: number;
  population: { undatedExcluded: number; unparsedExcluded: number }; ready: boolean;
  gracePeriodMinutes: number; cadenceMinutes: number;
};

export function crawlerOnlyQuery(params: URLSearchParams) {
  const window = params.get('window') || '24h', site = params.get('site') || '',
    provider = params.get('provider') || 'both', show = params.get('show') || 'all',
    page = Number(params.get('page') || 1);
  if (!['1h','24h','7d'].includes(window) || (site && !sites.some(s => s.domain === site))
    || !['both',...providerIds].includes(provider) || !statuses.includes(show as CrawlerOnlyShow)
    || !Number.isInteger(page) || page < 1 || page > rowLimit / 50)
    throw new Error('Invalid crawler-only filter');
  return { window: window as CrawlerOnlyWindow, site, provider: provider as CrawlerOnlyProvider,
    show: show as CrawlerOnlyShow, page };
}

const emptyCounts = (): StatusCounts => ({ total: 0, comparable: 0, listed: 0, googleOnly: 0, exaOnly: 0,
  both: 0, possible: 0, strong: 0, weak: 0, pending: 0, notComparable: 0, crawlerOnly: 0 });
function countArticle(counts: StatusCounts, article: CrawlerOnlyArticle, selected: readonly ProviderId[]) {
  counts.total++;
  if (article.status === 'not_comparable') { counts.notComparable++; return; }
  counts.comparable++;
  counts[article.status]++;
  if (article.status === 'strong' || article.status === 'weak') counts.crawlerOnly++;
  if (article.status === 'listed') {
    const google = selected.includes('google') && article.google.status === 'listed';
    const exa = selected.includes('exa') && article.exa.status === 'listed';
    if (google && exa) counts.both++; else if (google) counts.googleOnly++; else if (exa) counts.exaOnly++;
  }
}
function selectedCount(counts: StatusCounts, show: CrawlerOnlyShow) {
  if (show === 'all') return counts.total;
  if (show === 'crawler_only') return counts.crawlerOnly;
  if (show === 'not_comparable') return counts.notComparable;
  return counts[show];
}
export function pageCrawlerOnly<T extends CrawlerOnlySnapshot>(snapshot: T, show: CrawlerOnlyShow = 'all', page = 1) {
  const rows = snapshot.articles.filter(row => show === 'all' || (show === 'crawler_only'
    ? row.status === 'strong' || row.status === 'weak' : row.status === show));
  return { ...snapshot, show, page, pageSize: 50, articles: rows.slice((page - 1) * 50, page * 50),
    groupCount: selectedCount(snapshot.summary, show), rowCount: rows.length,
    pageCount: Math.ceil(rows.length / 50) };
}

const key = (site: string, raw: string) => {
  const normalized = urlKey(raw);
  return normalized ? site + '|' + normalized : null;
};
const fetchedKeys = (row: Row) => [row.canonical_url,row.source_url,...(row.match_urls || [])]
  .flatMap(raw => typeof raw === 'string' ? [key(row.domain,raw)].filter((value): value is string => !!value) : []);
const titleIndexKey = (site: string, title: string) => site + '|' + matchingTitle(title,site);

function overall(evidence: ProviderEvidence[], hasFetch: boolean): CrawlerOnlyStatus {
  if (!hasFetch) return 'not_comparable';
  for (const status of ['listed','pending','possible','not_comparable','weak','strong'] as const)
    if (evidence.some(value => value.status === status)) return status;
  return 'not_comparable';
}

export class CrawlerOnlyReader {
  constructor(readonly monitorPath: string, readonly crawlerPath: string) {}
  dataset(window: CrawlerOnlyWindow, site: string, provider: CrawlerOnlyProvider, now: number): CrawlerOnlySnapshot {
    const start = now - windows[window], selected: readonly ProviderId[] = provider === 'both' ? providerIds : [provider];
    const crawler = new DatabaseSync(this.crawlerPath,{readOnly:true});
    const monitor = existsSync(this.monitorPath) ? new DatabaseSync(this.monitorPath,{readOnly:true}) : undefined;
    try {
      crawler.exec('PRAGMA query_only=ON;PRAGMA busy_timeout=2000');
      monitor?.exec('PRAGMA query_only=ON;PRAGMA busy_timeout=2000');
      const articles = crawler.prepare(ARTICLE_SELECT).all(site,site) as Row[];
      const fetched = fetchedArticles(crawler,articles,site,now);
      const byFetchedKey = new Map<string,Row>();
      for (const row of fetched) for (const identity of fetchedKeys(row)) byFetchedKey.set(identity,row);
      // Use the same complete fetched input as Coverage: filtering to this page's
      // population would remove ambiguous title candidates and change matches.
      const sightings = monitor?.prepare(`SELECT * FROM external_sightings
        WHERE provider IN ('google','exa') AND observed_at<=? AND (?='' OR site=?)
        ORDER BY provider_published_at DESC`).all(now,site,site) as Row[] | undefined;
      const listed: Record<ProviderId,Map<string,'url'|'title'>> = {google:new Map(),exa:new Map()};
      // A provider cell must not inherit the other provider's evidence from a
      // grouped title association. Each uses Coverage's matcher independently.
      for (const id of providerIds) for (const group of matchSightings((sightings || []).filter(row => row.provider === id),fetched)) {
        if (!group.match || !group.article_url) continue;
        const identity = key(group.site,group.article_url);
        if (!identity) continue;
        const record = byFetchedKey.get(identity), identities = new Set(record ? fetchedKeys(record) : [identity]);
        const direct = group.provider_timings.some(timing => !!key(group.site,timing.url)
          && identities.has(key(group.site,timing.url)!));
        const previous = listed[id].get(identity);
        listed[id].set(identity,previous === 'url' || direct ? 'url' : 'title');
      }
      const titles: Record<ProviderId,Set<string>> = {google:new Set(),exa:new Set()};
      for (const row of sightings || []) {
        if (!matchingTitle(row.title || '',row.site)) continue;
        titles[row.provider as ProviderId].add(titleIndexKey(row.site,row.title || ''));
      }
      const runs = monitor?.prepare(`SELECT * FROM provider_runs WHERE provider IN ('google','exa')
        AND finished_at IS NOT NULL AND finished_at<=? AND window_start<? AND window_end>?
        AND (?='' OR site=?) ORDER BY started_at DESC,id DESC`).all(now,now,start,site,site) as Row[] | undefined;
      const pollGroups = new Map<string,Row[]>();
      for (const run of runs || []) {
        if (!Number.isFinite(run.window_start) || !Number.isFinite(run.window_end) || run.window_start >= run.window_end) continue;
        const identity = run.site + '|' + run.provider;
        const list = pollGroups.get(identity) || []; list.push(run); pollGroups.set(identity,list);
      }
      const evidence = (article: Row, publication: number, download: Row | undefined, id: ProviderId): ProviderEvidence => {
        const polls = pollGroups.get(article.domain + '|' + id) || [];
        const last = polls.find(run => run.status === 'ok' && run.window_start <= publication && publication < run.window_end);
        const poll: Poll | null = last ? {id:Number(last.id),startedAt:Number(last.started_at),windowStart:Number(last.window_start),
          windowEnd:Number(last.window_end),truncated:!!last.truncated} : null;
        if (!download) return {status:'not_comparable',reason:'No saved successful crawler fetch is available for this parsed record.',match:null,poll};
        const identity = key(download.domain,download.canonical_url);
        const match = identity ? listed[id].get(identity) || null : null;
        if (match) return {status:'listed',reason:`Matched a stored ${providerNames[id]} sample by ${match}.`,match,poll};
        if (now - publication < gracePeriod) return {status:'pending',reason:`Published less than ${gracePeriod/60000} minutes ago; a later poll may still list it.`,match:null,poll};
        if (matchingTitle(article.title || '',article.domain) && titles[id].has(titleIndexKey(article.domain,article.title || '')))
          return {status:'possible',reason:`A stored ${providerNames[id]} row has the same normalized title, but the Coverage matcher did not confirm it.`,match:null,poll};
        if (!poll) return {status:'not_comparable',reason:`No successful ${id === 'google' ? 'Google' : 'Exa'} poll covered this publication time.`,match:null,poll};
        return {status:poll.truncated?'weak':'strong',reason:poll.truncated
          ? `The last successful covering ${providerNames[id]} poll hit its result cap.`
          : `The last successful covering ${providerNames[id]} poll was under its result cap.`,match:null,poll};
      };
      const domains = sites.filter(value => !site || value.domain === site).map(value => {
        const polls = Object.fromEntries(providerIds.map(id => {
          const rows = pollGroups.get(value.domain + '|' + id) || [], successful = rows.filter(run => run.status === 'ok'),
            capped = successful.filter(run => run.truncated).length;
          return [id,{successful:successful.length,capped,percentage:successful.length?capped/successful.length*100:null,
            failed:rows.filter(run => run.status !== 'ok').length}];
        })) as Record<ProviderId,PollCounts>;
        return {site:value.domain,...emptyCounts(),polls};
      });
      const byDomain = new Map(domains.map(value => [value.site,value]));
      const summary = emptyCounts(), population = {undatedExcluded:0,unparsedExcluded:fetched.filter(row => row.fetched == null).length};
      const rows: CrawlerOnlyArticle[] = [];
      const dated: {article:Row;publication:number}[] = [];
      for (const article of articles) {
        const publication = date(article.published);
        if (publication === null) {population.undatedExcluded++;continue;}
        if (publication < start || publication >= now) continue;
        dated.push({article,publication});
      }
      dated.sort((a,b)=>b.publication-a.publication || b.article.fetched-a.article.fetched
        || a.article.canonical_url.localeCompare(b.article.canonical_url));
      for (const {article,publication} of dated) {
        const download = byFetchedKey.get(key(article.domain,article.canonical_url) || '')
          || byFetchedKey.get(key(article.domain,article.source_url || '') || '');
        const google = evidence(article,publication,download,'google'), exa = evidence(article,publication,download,'exa');
        const row: CrawlerOnlyArticle = {url:article.canonical_url,title:article.title || article.canonical_url,site:article.domain,
          publishedAt:publication,parsedAt:article.fetched,fetchFinishedAt:download?.fetch_finished_at ?? null,
          requestId:download?.request_id ?? null,status:overall(selected.map(id => id === 'google' ? google : exa),!!download),
          incomplete:article.classification === 'incomplete',google,exa};
        if(rows.length<rowLimit)rows.push(row);
        countArticle(summary,row,selected);
        const domain = byDomain.get(row.site);if (domain) countArticle(domain,row,selected);
      }
      return {window,windowStart:start,windowEnd:now,windowTimestamp:'article_published_at',generatedAt:now,
        sites:sites.map(value => value.domain),provider,selectedProviders:selected,summary,domains,
        articles:rows,rowsLimit:rowLimit,rowsTruncated:summary.total>rowLimit,totalRows:summary.total,
        population,ready:!!monitor,gracePeriodMinutes:gracePeriod/60000,cadenceMinutes:pollInterval/60000};
    } finally {monitor?.close();crawler.close();}
  }
}
