// Host keys are checked against the site policies at startup.
export const sourceHostPriorities: Record<string, (path: string) => number | undefined> = {
  'www.hurriyet.com.tr': path => path === '/son-dakika-haberleri/' ? 100 : undefined,
  'finance.eastmoney.com': path => ['/yaowen.html', '/news/cgnjj.html'].includes(path) ? 100 : undefined,
  // Legacy maps contain October 2017 articles.
  'www.eastmoney.com': path => path === '/sitemap.xml' ? -100 : undefined,
  'rss.eastmoney.com': path => /^\/sitemaps\/(?:stock|finance|hk|forex)_sitemap\.xml\.gz$/.test(path) ? -100 : undefined,
  // This legacy list returns a script redirect to /roll/c/51894.shtml.
  'finance.sina.com.cn': path => path === '/roll/index.d.html' ? -100 : undefined,
};

export function sourcePriority(url: string, kind: string, now = Date.now()): number {
  let path: string;
  try {
    const parsed=new URL(url);path=parsed.pathname;
    const priority = sourceHostPriorities[parsed.hostname]?.(path);
    if (priority !== undefined) return priority;
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
  if (kind === 'rss' || kind === 'feed') return 80;
  if (kind.startsWith('api:')) return 100;
  if (kind === 'html' || kind.startsWith('html:')) return 60;
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

// This publisher rotates daily children under a stable index. At most today and
// yesterday qualify, so its feed directory cannot crowd out the live maps.
export function isCurrentYoum7Sitemap(url: string, now = Date.now()): boolean {
  return /^https:\/\/www\.youm7\.com\/Sitemap\/20\d{2}\/\d{1,2}\/\d{1,2}$/.test(url)
    && sourcePriority(url, 'sitemap', now) >= 0;
}
