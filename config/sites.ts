import type { SitePolicy } from '../packages/core/src/types.js';

// Each domain and all of its subdomains share one request budget.
// Plain JSON-compatible data. Named profile definitions live in profiles.ts.
// Sources are starting points, not a complete census; normal discovery continues.
export const siteDefaults: readonly SitePolicy[] = [
  { domain: 'sina.com.cn', requestsPerMinute: 30, enabled: true, fetchProfile: 'crawler', articleProfiles: [{ use: 'sina-article' }], discoverySources: [
    { kind: 'api', adapter: 'sina-roll', url: 'https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2509&num=50&page=1' },
    { kind: 'html', url: 'https://finance.sina.com.cn/roll/c/51894.shtml' },
    { kind: 'api', adapter: 'sina-roll', url: 'https://feed.mix.sina.com.cn/api/roll/get?pageid=506&lid=3328&num=50&page=1' },
    { kind: 'html', url: 'https://finance.sina.com.cn/' },
    { kind: 'html', url: 'https://news.sina.com.cn/' },
  ] },
  { domain: 'indiatimes.com', requestsPerMinute: 15, enabled: true, fetchProfile: 'crawler', articleProfiles: [{ use: 'generic' }], discoverySources: [
    { kind: 'sitemap', url: 'https://timesofindia.indiatimes.com/staticsitemap/toi/news/sitemap-today-1.xml' },
    { kind: 'feed', url: 'https://economictimes.indiatimes.com/news/latest-news/rssfeeds/20989204.cms' },
    { kind: 'html', url: 'https://timesofindia.indiatimes.com/' },
    { kind: 'html', url: 'https://economictimes.indiatimes.com/' },
  ] },
  { domain: 'chosun.com', requestsPerMinute: 10, enabled: true, fetchProfile: 'crawler', articleProfiles: [{ use: 'arc-story', hosts: ['www.chosun.com', 'biz.chosun.com'] }], discoverySources: [
    { kind: 'sitemap', url: 'https://www.chosun.com/arc/outboundfeeds/news-sitemap/?outputType=xml' },
    { kind: 'sitemap', url: 'https://biz.chosun.com/arc/outboundfeeds/news-sitemap/?outputType=xml' },
  ] },
  { domain: 'antaranews.com', requestsPerMinute: 10, enabled: true, fetchProfile: 'crawler', articleProfiles: [{ use: 'generic' }], discoverySources: [
    { kind: 'feed', url: 'https://www.antaranews.com/rss/terkini.xml' },
  ] },
  { domain: 'bbc.com', requestsPerMinute: 5, enabled: true, fetchProfile: 'crawler', articleProfiles: [{ use: 'generic' }], discoverySources: [
    { kind: 'sitemap', url: 'https://www.bbc.com/sitemaps/https-index-com-news.xml' },
  ] },
  { domain: 'hoodline.com', requestsPerMinute: 5, enabled: true, fetchProfile: 'chrome', articleProfiles: [{ use: 'generic' }], discoverySources: [
    { kind: 'feed', url: 'https://hoodline.com/rss' },
  ] },
  { domain: 'udn.com', requestsPerMinute: 5, enabled: true, fetchProfile: 'crawler', articleProfiles: [{ use: 'generic' }], discoverySources: [
    { kind: 'sitemap', url: 'https://udn.com/sitemap/gnews_contents/2/1' },
  ] },
  { domain: 'hurriyet.com.tr', requestsPerMinute: 5, enabled: true, fetchProfile: 'crawler', articleProfiles: [{ use: 'generic' }], discoverySources: [
    { kind: 'html', url: 'https://www.hurriyet.com.tr/son-dakika-haberleri/' },
  ] },
  { domain: 'haberturk.com', requestsPerMinute: 5, enabled: true, fetchProfile: 'crawler', articleProfiles: [{ use: 'generic' }], discoverySources: [
    { kind: 'sitemap', url: 'https://www.haberturk.com/sitemap_google_news.xml' },
    { kind: 'sitemap', url: 'https://www.haberturk.com/sitemap_recentlocal_news.xml' },
  ] },
  { domain: 'youm7.com', requestsPerMinute: 3, enabled: true, fetchProfile: 'crawler', articleProfiles: [{ use: 'generic' }], discoverySources: [
    { kind: 'html', url: 'https://www.youm7.com/' },
  ] },
  { domain: 'eastmoney.com', requestsPerMinute: 3, enabled: true, fetchProfile: 'crawler', articleProfiles: [{ use: 'eastmoney-article' }], discoverySources: [
    { kind: 'html', url: 'http://finance.eastmoney.com/yaowen.html' },
    { kind: 'html', url: 'http://finance.eastmoney.com/news/cgnjj.html' },
  ] },
  { domain: 'eldiario.es', requestsPerMinute: 3, enabled: true, fetchProfile: 'crawler', articleProfiles: [{ use: 'generic' }], discoverySources: [
    { kind: 'sitemap', url: 'https://www.eldiario.es/sitemap_google_news_25b87.xml' },
  ] },
  { domain: 'ce.cn', requestsPerMinute: 3, enabled: true, fetchProfile: 'crawler', articleProfiles: [{ use: 'ce-article' }], discoverySources: [
    { kind: 'html', url: 'https://www.ce.cn/' },
  ] },
  { domain: 'cnnbrasil.com.br', requestsPerMinute: 2, enabled: true, fetchProfile: 'crawler', articleProfiles: [{ use: 'generic' }], discoverySources: [
    { kind: 'sitemap', url: 'https://admin.cnnbrasil.com.br/sitemap-news.xml' },
  ] },
  { domain: 'biobiochile.cl', requestsPerMinute: 2, enabled: true, fetchProfile: 'crawler', articleProfiles: [{ use: 'generic' }], discoverySources: [
    { kind: 'feed', url: 'https://www.biobiochile.cl/static/feed-rss' },
    { kind: 'sitemap', url: 'https://www.biobiochile.cl/news-sitemap.xml' },
  ] },
  { domain: 'elmundo.es', requestsPerMinute: 2, enabled: true, fetchProfile: 'crawler', articleProfiles: [{ use: 'generic' }], discoverySources: [
    { kind: 'sitemap', url: 'https://www.elmundo.es/sitemaps/all_news_ba73c5f391df9f719f50ce13ec4f4c83.xml' },
  ] },
  { domain: 'mediapart.fr', requestsPerMinute: 2, enabled: true, fetchProfile: 'crawler', articleProfiles: [{ use: 'generic' }], discoverySources: [
    { kind: 'html', url: 'https://www.mediapart.fr/' },
    { kind: 'sitemap', url: 'https://www.mediapart.fr/news_sitemap_editor_choice.xml' },
  ] },
  { domain: 'eleconomista.es', requestsPerMinute: 2, enabled: true, fetchProfile: 'chrome', articleProfiles: [{ use: 'generic' }], discoverySources: [
    { kind: 'sitemap', url: 'https://www.eleconomista.es/sitemap_news_ssl.php' },
  ] },
  { domain: 'newindianexpress.com', requestsPerMinute: 2, enabled: true, fetchProfile: 'crawler', articleProfiles: [{ use: 'generic' }], discoverySources: [
    { kind: 'sitemap', url: 'https://www.newindianexpress.com/news_sitemap.xml' },
  ] },
  { domain: 'zaobao.com.sg', requestsPerMinute: 2, enabled: true, fetchProfile: 'crawler', articleProfiles: [{ use: 'generic' }], discoverySources: [
    { kind: 'html', url: 'https://www.zaobao.com.sg/realtime' },
    { kind: 'html', url: 'https://www.zaobao.com.sg/' },
  ] },
];
