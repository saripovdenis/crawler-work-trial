const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const article = readFileSync(resolve(__dirname, '../../fixtures/article.html'), 'utf8');
const feed = readFileSync(resolve(__dirname, '../../fixtures/feed.xml'), 'utf8');
exports.responseFor = url => {
  const { pathname, origin } = new URL(url);
  if (pathname === '/robots.txt') return { status: 200, body: 'User-agent: *\nAllow: /\n', headers: { 'content-type': 'text/plain' } };
  if (/rss|feed|sitemap|\.xml/i.test(pathname)) return { status: 200, body: feed.replaceAll('ORIGIN', origin), headers: { 'content-type': 'application/xml' } };
  if (pathname === '/') return { status: 200, body: '<html><head><link rel="alternate" type="application/rss+xml" href="/rss.xml"></head><body><a href="/news/articles/100001">Simulator news article</a></body></html>', headers: { 'content-type': 'text/html' } };
  return { status: 200, body: article, headers: { 'content-type': 'text/html' } };
};
