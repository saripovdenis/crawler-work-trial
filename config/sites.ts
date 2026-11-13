import type { SitePolicy } from '../packages/core/src/types.js';

// Each domain and all of its subdomains share one request budget.
export const siteDefaults: readonly SitePolicy[] = [
  { domain: 'sina.com.cn', requestsPerMinute: 30, enabled: true, transport: 'node', discoverySources: [
    { kind: 'api', adapter: 'sina-roll', url: 'https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2509&num=50&page=1' },
    { kind: 'html', url: 'https://finance.sina.com.cn/roll/c/51894.shtml' },
    { kind: 'api', adapter: 'sina-roll', url: 'https://feed.mix.sina.com.cn/api/roll/get?pageid=506&lid=3328&num=50&page=1' },
    { kind: 'html', url: 'https://finance.sina.com.cn/' },
    { kind: 'html', url: 'https://news.sina.com.cn/' },
  ] },
  { domain: 'indiatimes.com', requestsPerMinute: 15, enabled: true, transport: 'node', discoverySources: [
    { kind: 'html', url: 'https://timesofindia.indiatimes.com/' },
    { kind: 'html', url: 'https://economictimes.indiatimes.com/' },
  ] },
  { domain: 'chosun.com', requestsPerMinute: 10, enabled: true, transport: 'node' },
  { domain: 'antaranews.com', requestsPerMinute: 10, enabled: true, transport: 'node' },
  { domain: 'bbc.com', requestsPerMinute: 5, enabled: true, transport: 'node', discoverySources: [
    { kind: 'sitemap', url: 'https://www.bbc.com/sitemaps/https-index-com-news.xml' },
  ] },
  { domain: 'hoodline.com', requestsPerMinute: 5, enabled: true, transport: 'chrome136' },
  { domain: 'udn.com', requestsPerMinute: 5, enabled: true, transport: 'node' },
  { domain: 'hurriyet.com.tr', requestsPerMinute: 5, enabled: true, transport: 'node', discoverySources: [
    { kind: 'html', url: 'https://www.hurriyet.com.tr/son-dakika-haberleri/' },
  ] },
  { domain: 'haberturk.com', requestsPerMinute: 5, enabled: true, transport: 'node' },
  { domain: 'youm7.com', requestsPerMinute: 3, enabled: true, transport: 'node' },
  { domain: 'eastmoney.com', requestsPerMinute: 3, enabled: true, transport: 'node', discoverySources: [
    { kind: 'html', url: 'http://finance.eastmoney.com/yaowen.html' },
    { kind: 'html', url: 'http://finance.eastmoney.com/news/cgnjj.html' },
  ] },
  { domain: 'eldiario.es', requestsPerMinute: 3, enabled: true, transport: 'node' },
  { domain: 'ce.cn', requestsPerMinute: 3, enabled: true, transport: 'node' },
  { domain: 'cnnbrasil.com.br', requestsPerMinute: 2, enabled: true, transport: 'node' },
  { domain: 'biobiochile.cl', requestsPerMinute: 2, enabled: true, transport: 'node' },
  { domain: 'elmundo.es', requestsPerMinute: 2, enabled: true, transport: 'node' },
  { domain: 'mediapart.fr', requestsPerMinute: 2, enabled: true, transport: 'node' },
  { domain: 'eleconomista.es', requestsPerMinute: 2, enabled: true, transport: 'chrome136' },
  { domain: 'newindianexpress.com', requestsPerMinute: 2, enabled: true, transport: 'node' },
  { domain: 'zaobao.com.sg', requestsPerMinute: 2, enabled: true, transport: 'node' },
];
