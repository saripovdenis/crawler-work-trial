// Keep a stable source identity, but record the actual cache-busting request
// URL in the ledger and assignment. This function performs no network I/O.
export function requestUrl(url: string, purpose: string, now: number): string {
  if (purpose !== 'discovery') return url;
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'np-weblist.eastmoney.com'
    || !['/comm/web/getFastNewsList', '/comm/web/getFastNewsZhibo'].includes(endpoint.pathname)) return url;
  endpoint.searchParams.set('req_trace', String(now));
  return endpoint.href;
}
