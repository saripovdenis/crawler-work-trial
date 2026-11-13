import { domainFor } from "../../core/src/policy.js";
export function urlKey(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (!domainFor(u.href)) return null;
    u.hash = "";
    for (const k of [...u.searchParams.keys()])
      if (/^(utm_|fbclid$|gclid$)/i.test(k)) u.searchParams.delete(k);
    if (domainFor(u.href) === 'udn.com') {
      for (const key of ['from', 'form'])
        if (/^udn[-_]/i.test(u.searchParams.get(key) || '')) u.searchParams.delete(key);
    }
    u.searchParams.sort();
    return (
      u.hostname.replace(/^www\./, "") +
      u.pathname.replace(/\/$/, "") +
      (u.search || "")
    );
  } catch {
    return null;
  }
}
export function titleKey(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
// Remove only recognized, terminal publisher boilerplate. Never fuzzy-match a
// changed headline; domain/date uniqueness checks still apply in the matcher.
export function matchingTitle(value: string, domain: string) {
  const suffixes: Record<string, RegExp> = {
    'haberturk.com': /(?:\s+-\s+[^-]{1,80} Haber(?:ler|leri)?)?\s+-\s+Habert[üu]rk(?: Yerel Haberler| Son Dakika Haber| Haberler)?\s*$/iu,
    'eastmoney.com': /\s*[_|–—-]\s*东方财富网\s*$/u,
    'ce.cn': /\s*[_|–—-]\s*中国经济网(?:——国家经济门户)?\s*$/u,
    'sina.com.cn': /\s*[_|–—-]\s*新浪(?:财经|网|新闻)(?:[_|–—-]新浪网)?\s*$/u,
    'indiatimes.com': /\s+[|–—-]\s+(?:Times of India|The Economic Times|IndiaTimes|Indiatimes)(?:\s+News)?\s*$/iu,
    'bbc.com': /\s+[|–—-]\s+BBC(?: News)?\s*$/iu,
    'antaranews.com': /\s+[|–—-]\s+ANTARA(?: News)?\s*$/iu,
  };
  return titleKey(suffixes[domain] ? value.replace(suffixes[domain], '') : value);
}
export function date(value: unknown): number | null {
  if (
    typeof value !== "string" ||
    !/(?:Z|[+-]\d\d:?\d\d|GMT|UTC)\s*$/i.test(value)
  )
    return null;
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : null;
}
export type Sighting = {
  url_raw: string;
  url_key: string | null;
  title: string;
  title_key: string;
  provider_published_at: number | null;
  provider_first_seen_at: number | null;
  // Host the provider names as the row's source. For a Google wrapper link it
  // is the only trace of the real URL; ./matching uses it to recognise page types.
  source_host?: string | null;
};
export function sighting(
  site: string,
  url: string,
  title: string,
  published: number | null,
  seen: number | null = null,
): Sighting | null {
  if (domainFor(url) !== site) return null;
  return {
    url_raw: url,
    url_key: urlKey(url),
    title,
    title_key: titleKey(title),
    provider_published_at: published,
    provider_first_seen_at: seen,
    source_host: new URL(url).hostname.toLowerCase(),
  };
}
