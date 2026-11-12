import test from 'node:test';
import assert from 'node:assert/strict';
import { nextAllowed, domainFor, classify, dateIso } from './policy.js';
import { discover, parseArticle } from './parse.js';

test('setup and steady-state rolling windows, including transition and restart history', () => {
  assert.equal(nextAllowed(1500, 0, 2, [1000]), 2020);
  assert.equal(nextAllowed(700_000, 0, 2, [670_000, 699_000]), 730_020);
  assert.equal(nextAllowed(600_000, 0, 2, [598_000, 599_000]), 658_020);
  for (const rpm of [2, 3, 5, 10, 15, 30]) {
    const times: number[] = [];
    let now = 0;
    while (now < 720_000) {
      const due = nextAllowed(now, 0, rpm, times.slice(-61));
      if (due > now) { now = due; continue; }
      times.push(now);
      const window = times.filter(t => t > now - 60_000);
      assert.ok(window.length <= (now < 600_000 ? 60 : rpm));
      now++;
    }
  }
});
test('subdomains share their configured site; lookalikes and other protocols excluded', () => {
  assert.equal(domainFor('https://news.sina.com.cn/a'), 'sina.com.cn');
  assert.equal(domainFor('https://bbc.com.evil.test/a'), undefined);
  assert.equal(domainFor('file:///etc/passwd'), undefined);
  assert.equal(domainFor('https://bbc.com:1234/a'), undefined);
});
test('missing zones and modification dates cannot make an article fresh', () => {
  assert.equal(dateIso('2026-11-12T10:00:00'), null);
  assert.equal(classify(null, 1000, 2000, false, true), 'unknown_date');
  assert.equal(classify(new Date(999).toISOString(), 1000, 2000, false, true), 'old');
  assert.equal(classify(new Date(1500).toISOString(), 1000, 2000, false, true), 'new');
  assert.equal(classify(new Date(2500).toISOString(), 1000, 2000, false, true), 'future_date');
  assert.equal(classify(new Date(1500).toISOString(), 1000, 2000, true, true), 'duplicate');
});
test('news sitemap publication dates, RSS and Atom; lastmod is not publication', () => {
  const site = 'https://www.bbc.com/';
  const sitemap = discover('<urlset xmlns:news="x"><url><loc>https://www.bbc.com/news/articles/one</loc><lastmod>2026-11-12T10:00:00Z</lastmod></url><url><loc>https://www.bbc.com/news/articles/two</loc><news:news><news:publication_date>2026-11-12T10:00:00Z</news:publication_date></news:news></url></urlset>', site, 'sitemap');
  assert.equal(sitemap.articles[0].published, null);
  assert.equal(sitemap.articles[1].published, '2026-11-12T10:00:00.000Z');
  const rss = discover('<rss><channel><item><link>https://www.bbc.com/news/articles/one</link><pubDate>Thu, 12 Nov 2026 10:00:00 GMT</pubDate></item></channel></rss>', site, 'feed');
  assert.equal(rss.articles[0].published, '2026-11-12T10:00:00.000Z');
  const atom = discover('<feed><entry><link href="https://www.bbc.com/news/articles/one"/><updated>2026-11-12T10:00:00Z</updated></entry></feed>', site, 'feed');
  assert.equal(atom.articles[0].published, null);
});
test('article extraction includes canonical, text, social tags, publication evidence', () => {
  const article = parseArticle(`<html><head><title>Test news</title><link rel="canonical" href="/news/articles/test"/><meta property="og:type" content="article"/><meta property="og:title" content="Test news"/><script type="application/ld+json">{"@type":"NewsArticle","headline":"Test news","datePublished":"2026-11-12T10:00:00Z","dateModified":"2026-11-12T11:00:00Z"}</script></head><body><article><h1>Test news</h1><p>${'A real article sentence. '.repeat(40)}</p></article></body></html>`, 'https://www.bbc.com/foo', Date.now(), null);
  assert.equal(article.canonicalUrl, 'https://www.bbc.com/news/articles/test');
  assert.equal(article.publishedAt, '2026-11-12T10:00:00.000Z');
  assert.equal(article.dateSource, 'jsonld.datePublished');
  assert.ok(article.text.length > 200);
  assert.equal(article.socialTags['og:title'][0], 'Test news');
});
