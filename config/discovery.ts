// Exploration seeds, never external article URLs. Every fetch still passes robots
// and the existing shared-domain budget. These cover publishers' main news desks.
export const discoverySeeds = [
  { domain: 'sina.com.cn', url: 'https://finance.sina.com.cn/', kind: 'html' },
  { domain: 'sina.com.cn', url: 'https://news.sina.com.cn/', kind: 'html' },
  { domain: 'indiatimes.com', url: 'https://timesofindia.indiatimes.com/', kind: 'html' },
  { domain: 'indiatimes.com', url: 'https://economictimes.indiatimes.com/', kind: 'html' },
  // Advertised in BBC's already archived robots.txt, previously beyond first six.
  { domain: 'bbc.com', url: 'https://www.bbc.com/sitemaps/https-index-com-news.xml', kind: 'sitemap' },
] as const;

export function sourcePriority(url: string, kind: string): number {
  let path: string;
  try { path = new URL(url).pathname; } catch { return -100; }
  if (/archive|tags?\b|author|video|image|imsakiye|\b20\d\d[-/]/i.test(path)) return -100;
  if (/48hours|google[_-]?news|[-_/]news[._-]|recent|latest/i.test(path)) return 100;
  if (kind === 'feed') return 80;
  if (kind === 'html') return 60;
  return 0;
}
