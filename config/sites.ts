import type { SiteConfig } from '../packages/core/src/types.js';

// Each domain and all of its subdomains share one request budget.
// Defaults: Python curl_cffi with crawler headers, then generic article extraction.
// Only exceptions select a fetchProfile or articleAdapter from profiles.ts.
// Sources are starting points, not a complete census; normal discovery continues.
export const siteDefaults: readonly SiteConfig[] = [
  { domain: 'sina.com.cn', requestsPerMinute: 30, articleAdapter: 'sina', seeds: [
    { kind: 'api', adapter: 'sina-roll', url: 'https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2509&num=50&page=1', pollEveryMs: 30_000 },
    { kind: 'html', url: 'https://finance.sina.com.cn/roll/c/51894.shtml', pollEveryMs: 120_000 },
    { kind: 'api', adapter: 'sina-roll', url: 'https://feed.mix.sina.com.cn/api/roll/get?pageid=506&lid=3328&num=50&page=1', pollEveryMs: 30_000 },
    { kind: 'html', url: 'https://finance.sina.com.cn/', pollEveryMs: 120_000 },
    { kind: 'html', url: 'https://news.sina.com.cn/', pollEveryMs: 120_000 },
  ] },
  { domain: 'indiatimes.com', requestsPerMinute: 15, seeds: [
    { kind: 'sitemap', url: 'https://timesofindia.indiatimes.com/staticsitemap/toi/news/sitemap-today-1.xml', pollEveryMs: 120_000 },
    { kind: 'rss', url: 'https://economictimes.indiatimes.com/news/latest-news/rssfeeds/20989204.cms', pollEveryMs: 60_000 },
    { kind: 'html', url: 'https://timesofindia.indiatimes.com/', pollEveryMs: 120_000 },
    { kind: 'html', url: 'https://economictimes.indiatimes.com/', pollEveryMs: 120_000 },
  ] },
  { domain: 'chosun.com', requestsPerMinute: 10, articleAdapter: 'chosun', seeds: [
    { kind: 'rss', url: 'https://www.chosun.com/arc/outboundfeeds/rss/?outputType=xml', pollEveryMs: 60_000 },
    { kind: 'sitemap', url: 'https://www.chosun.com/arc/outboundfeeds/news-sitemap/?outputType=xml', pollEveryMs: 120_000 },
    { kind: 'sitemap', url: 'https://biz.chosun.com/arc/outboundfeeds/news-sitemap/?outputType=xml', pollEveryMs: 120_000 },
  ] },
  { domain: 'antaranews.com', requestsPerMinute: 10, seeds: [
    { kind: 'rss', url: 'https://www.antaranews.com/rss/terkini.xml', pollEveryMs: 60_000 },
  ] },
  { domain: 'bbc.com', requestsPerMinute: 5, seeds: [
    { kind: 'sitemap', url: 'https://www.bbc.com/sitemaps/https-index-com-news.xml', pollEveryMs: 120_000 },
  ] },
  { domain: 'hoodline.com', requestsPerMinute: 5, fetchProfile: 'chrome', seeds: [
    { kind: 'rss', url: 'https://hoodline.com/rss', pollEveryMs: 120_000 },
  ] },
  { domain: 'udn.com', requestsPerMinute: 5, seeds: [
    { kind: 'rss', url: 'https://udn.com/news/rssfeed', pollEveryMs: 120_000 },
    { kind: 'sitemap', url: 'https://udn.com/sitemap/gnews_contents/2/1', pollEveryMs: 120_000 },
  ] },
  { domain: 'hurriyet.com.tr', requestsPerMinute: 5, seeds: [
    { kind: 'rss', url: 'https://www.hurriyet.com.tr/rss/anasayfa', pollEveryMs: 120_000 },
    { kind: 'html', url: 'https://www.hurriyet.com.tr/son-dakika-haberleri/', pollEveryMs: 120_000 },
  ] },
  { domain: 'haberturk.com', requestsPerMinute: 5, seeds: [
    { kind: 'rss', url: 'https://www.haberturk.com/rss/manset.xml', pollEveryMs: 120_000 },
    { kind: 'sitemap', url: 'https://www.haberturk.com/sitemap_google_news.xml', pollEveryMs: 120_000 },
    { kind: 'sitemap', url: 'https://www.haberturk.com/sitemap_recentlocal_news.xml', pollEveryMs: 120_000 },
  ] },
  { domain: 'youm7.com', requestsPerMinute: 3, seeds: [
    { kind: 'html', url: 'https://www.youm7.com/', pollEveryMs: 180_000 },
  ] },
  { domain: 'eastmoney.com', requestsPerMinute: 3, articleAdapter: 'eastmoney', seeds: [
    { kind: 'html', url: 'http://finance.eastmoney.com/yaowen.html', pollEveryMs: 180_000 },
    { kind: 'html', url: 'http://finance.eastmoney.com/news/cgnjj.html', pollEveryMs: 180_000 },
  ] },
  { domain: 'eldiario.es', requestsPerMinute: 3, seeds: [
    { kind: 'rss', url: 'https://www.eldiario.es/rss/', pollEveryMs: 180_000 },
    { kind: 'sitemap', url: 'https://www.eldiario.es/sitemap_google_news_25b87.xml', pollEveryMs: 300_000 },
  ] },
  { domain: 'ce.cn', requestsPerMinute: 3, articleAdapter: 'ce', seeds: [
    { kind: 'html', url: 'https://www.ce.cn/', pollEveryMs: 180_000 },
  ] },
  { domain: 'cnnbrasil.com.br', requestsPerMinute: 2, seeds: [
    { kind: 'rss', url: 'https://admin.cnnbrasil.com.br/feed/', pollEveryMs: 180_000 },
    { kind: 'sitemap', url: 'https://admin.cnnbrasil.com.br/sitemap-news.xml', pollEveryMs: 300_000 },
  ] },
  { domain: 'biobiochile.cl', requestsPerMinute: 2, seeds: [
    { kind: 'rss', url: 'https://www.biobiochile.cl/static/feed-rss', pollEveryMs: 120_000 },
    { kind: 'sitemap', url: 'https://www.biobiochile.cl/news-sitemap.xml', pollEveryMs: 300_000 },
  ] },
  { domain: 'elmundo.es', requestsPerMinute: 2, seeds: [
    { kind: 'rss', url: 'https://www.elmundo.es/rss/googlenews/portada.xml', pollEveryMs: 180_000 },
    { kind: 'sitemap', url: 'https://www.elmundo.es/sitemaps/all_news_ba73c5f391df9f719f50ce13ec4f4c83.xml', pollEveryMs: 300_000 },
  ] },
  { domain: 'mediapart.fr', requestsPerMinute: 2, seeds: [
    { kind: 'rss', url: 'https://www.mediapart.fr/articles/feed', pollEveryMs: 300_000 },
    { kind: 'html', url: 'https://www.mediapart.fr/', pollEveryMs: 180_000 },
    { kind: 'sitemap', url: 'https://www.mediapart.fr/news_sitemap_editor_choice.xml', pollEveryMs: 300_000 },
  ] },
  { domain: 'eleconomista.es', requestsPerMinute: 2, fetchProfile: 'chrome', seeds: [
    { kind: 'sitemap', url: 'https://www.eleconomista.es/sitemap_news_ssl.php', pollEveryMs: 300_000 },
  ] },
  { domain: 'newindianexpress.com', requestsPerMinute: 2, seeds: [
    { kind: 'sitemap', url: 'https://www.newindianexpress.com/news_sitemap.xml', pollEveryMs: 300_000 },
  ] },
  { domain: 'zaobao.com.sg', requestsPerMinute: 2, seeds: [
    { kind: 'html', url: 'https://www.zaobao.com.sg/realtime', pollEveryMs: 180_000 },
    { kind: 'html', url: 'https://www.zaobao.com.sg/', pollEveryMs: 180_000 },
  ] },
];
