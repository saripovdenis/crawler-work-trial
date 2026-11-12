// Exploration seeds, never external article URLs. Every fetch still passes robots
// and the existing shared-domain budget. These cover publishers' main news desks.
export const discoverySeeds = [
  { domain: 'sina.com.cn', url: 'https://finance.sina.com.cn/', kind: 'html' },
  { domain: 'sina.com.cn', url: 'https://news.sina.com.cn/', kind: 'html' },
  // Rolling lists linked from the archived publisher homepages.
  { domain: 'sina.com.cn', url: 'http://finance.sina.com.cn/roll/index.d.html?cid=56975&page=1', kind: 'html' },
  { domain: 'sina.com.cn', url: 'https://news.sina.com.cn/airoll/index.shtml', kind: 'html' },
  { domain: 'indiatimes.com', url: 'https://timesofindia.indiatimes.com/', kind: 'html' },
  { domain: 'indiatimes.com', url: 'https://economictimes.indiatimes.com/', kind: 'html' },
  // Advertised in BBC's already archived robots.txt, previously beyond first six.
  { domain: 'bbc.com', url: 'https://www.bbc.com/sitemaps/https-index-com-news.xml', kind: 'sitemap' },
] as const;

export function sourcePriority(url: string, kind: string): number {
  let path: string;
  try { path = new URL(url).pathname; } catch { return -100; }
  if (/archive|tags?\b|author|video|image|imsakiye|updateoldcontents/i.test(path)) return -100;
  if (/48hours|google[_-]?news|[-_/]news[._-]|gnews|airoll|\/roll\/index|recent|latest/i.test(path)) return 100;
  if (/\b20\d\d[-/]/i.test(path)) return -100;
  if (kind === 'feed') return 80;
  if (kind === 'html') return 60;
  return 0;
}

// A URL date changes queue priority only, never publication metadata or newness.
export function urlRecencyPriority(url: string, now: number): number {
  const match = new URL(url).pathname.match(/\/(20\d\d)-(\d\d)-(\d\d)\//);
  if (!match) return 50;
  const day = Date.parse(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  const today = Math.floor(now / 86400_000) * 86400_000;
  return day >= today - 86400_000 && day <= today + 86400_000 ? 75 : 50;
}
