import { normalizeUrl, domainFor, isKnownListingUrl } from './policy.js';

// Pure response parsing: pagination is returned to the scheduler, never fetched
// here. A bounded rolling window avoids turning discovery into an archive crawl.
export function discoverApi(body: string, url: string, kind: string) {
  if (kind === 'api:eastmoney-live') return discoverEastmoneyLive(body, url);
  if (kind !== 'api:sina-roll') throw new Error(`Unsupported discovery adapter: ${kind}`);
  const endpoint = new URL(url);
  if (endpoint.hostname !== 'feed.mix.sina.com.cn' || endpoint.pathname !== '/api/roll/get')
    throw new Error('Unexpected URL for sina-roll');
  const result = JSON.parse(body)?.result;
  if (result?.status?.code !== 0 || !Array.isArray(result.data))
    throw new Error('Invalid sina-roll response');
  const articles: {url: string; published: null}[] = [];
  let partial = false;
  for (const row of result.data) {
    const next = typeof row?.url === 'string' ? normalizeUrl(row.url, url) : null;
    if (!next || domainFor(next) !== 'sina.com.cn') { partial = true; continue; }
    if (!isKnownListingUrl(next)) articles.push({url: next, published: null});
    // ctime/mtime/intime have different meanings. Fetch the article to establish
    // its publication date; none of these becomes a publication hint here.
  }
  const sources: {url: string; kind: string}[] = [];
  const page = Number(endpoint.searchParams.get('page') || 1);
  const size = Number(endpoint.searchParams.get('num') || 50);
  if (!partial && Number.isInteger(page) && page >= 1 && page < 3
    && Number.isInteger(size) && size > 0 && result.data.length >= size) {
    endpoint.searchParams.set('page', String(page + 1));
    sources.push({url: endpoint.href, kind});
  }
  return {articles: [...new Map(articles.map(article => [article.url, article])).values()], sources, partial};
}

function discoverEastmoneyLive(body: string, url: string) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'np-weblist.eastmoney.com'
    || !['/comm/web/getFastNewsList', '/comm/web/getFastNewsZhibo'].includes(endpoint.pathname))
    throw new Error('Unexpected URL for eastmoney-live');
  const result = JSON.parse(body);
  if (result?.code !== 1 || !Array.isArray(result.data?.fastNewsList))
    throw new Error('Invalid eastmoney-live response');
  const articles: {url: string; published: null}[] = [];
  let partial = false;
  for (const row of result.data.fastNewsList) {
    // Codes exceed JS's safe integer range: never recover them from a number.
    if (typeof row?.code !== 'string' || !/^\d{18}$/.test(row.code)) { partial = true; continue; }
    articles.push({url: `https://finance.eastmoney.com/a/${row.code}.html`, published: null});
    // showTime is feed display time, not a verified article publication date.
    // Fetch completion supplies discovery time; article parsing supplies publication.
  }
  // Cursor pages are historical snapshots, not recurring sources. Poll the
  // overlapping latest 100 only; don't create an unbounded archive crawl.
  return {articles: [...new Map(articles.map(article => [article.url, article])).values()],
    sources: [] as {url: string; kind: string}[], partial};
}
