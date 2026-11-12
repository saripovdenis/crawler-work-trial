// Exploration seeds, never external article URLs. Every fetch still passes robots
// and the existing shared-domain budget. These cover publishers' main news desks.
export const discoverySeeds = [
  { domain: 'sina.com.cn', url: 'https://finance.sina.com.cn/', kind: 'html' },
  { domain: 'sina.com.cn', url: 'https://news.sina.com.cn/', kind: 'html' },
  // Rolling lists linked from the archived publisher homepages.
  // The old index returns a cached JavaScript redirect to this current list.
  { domain: 'sina.com.cn', url: 'https://finance.sina.com.cn/roll/c/51894.shtml', kind: 'html' },
  { domain: 'sina.com.cn', url: 'https://news.sina.com.cn/airoll/index.shtml', kind: 'html' },
  { domain: 'indiatimes.com', url: 'https://timesofindia.indiatimes.com/', kind: 'html' },
  { domain: 'indiatimes.com', url: 'https://economictimes.indiatimes.com/', kind: 'html' },
  // Current-news lists linked from the archived publisher homepages.
  { domain: 'hurriyet.com.tr', url: 'https://www.hurriyet.com.tr/son-dakika-haberleri/', kind: 'html' },
  { domain: 'eastmoney.com', url: 'http://finance.eastmoney.com/yaowen.html', kind: 'html' },
  { domain: 'eastmoney.com', url: 'http://finance.eastmoney.com/news/cgnjj.html', kind: 'html' },
  // Advertised in BBC's already archived robots.txt, previously beyond first six.
  { domain: 'bbc.com', url: 'https://www.bbc.com/sitemaps/https-index-com-news.xml', kind: 'sitemap' },
] as const;

export function sourcePriority(url: string, kind: string, now = Date.now()): number {
  let path: string;
  try {
    const parsed=new URL(url);path=parsed.pathname;
    if (parsed.hostname==='www.hurriyet.com.tr' && path==='/son-dakika-haberleri/') return 100;
    if (parsed.hostname==='finance.eastmoney.com' && ['/yaowen.html','/news/cgnjj.html'].includes(path)) return 100;
    // The index lists legacy maps; all 200 URLs in these four archived children are dated October 2017.
    if ((parsed.hostname==='www.eastmoney.com' && path==='/sitemap.xml')
        || (parsed.hostname==='rss.eastmoney.com' && /^\/sitemaps\/(?:stock|finance|hk|forex)_sitemap\.xml\.gz$/.test(path))) return -100;
    // This legacy list now returns only a script redirect to /roll/c/51894.shtml.
    if(parsed.hostname==='finance.sina.com.cn' && path==='/roll/index.d.html')return -100;
  } catch { return -100; }
  if (/archive|tags?\b|author|video|image|imsakiye|updateoldcontents/i.test(path)) return -100;
  const live=/48hours|google[_-]?news|[-_/]news[._-]|gnews|airoll|\/roll\/(?:index|c\/)|recent|latest/i.test(path);
  // A dated news map can be today's live source, not an archive. Keep today
  // and yesterday active; a future date or older dated map stays low priority.
  const dated=path.match(/\b(20\d\d)[-/](\d{1,2})[-/](\d{1,2})(?=[./_-]|$)/);
  if(dated) {
    const year=Number(dated[1]),month=Number(dated[2]),day=Number(dated[3]);
    const timestamp=Date.UTC(year,month-1,day),date=new Date(timestamp);
    const today=Math.floor(now/86400_000)*86400_000;
    const valid=date.getUTCFullYear()===year && date.getUTCMonth()===month-1 && date.getUTCDate()===day;
    return valid && timestamp>=today-86400_000 && timestamp<=today ? (live?100:90) : -100;
  }
  if(live) return 100;
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
