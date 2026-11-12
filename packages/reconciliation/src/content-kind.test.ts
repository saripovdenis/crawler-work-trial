import test from 'node:test';
import assert from 'node:assert/strict';
import { externalContentKind } from './content-kind.js';

test('known El Mundo navigation routes are not individual articles', () => {
  assert.deepEqual(externalContentKind('https://www.elmundo.es/e/et/eta.html', 'elmundo.es'),
    { kind: 'non_article', reason: 'topic_page' });
  assert.deepEqual(externalContentKind('https://www.elmundo.es/autor/esther-mucientes.html', 'elmundo.es'),
    { kind: 'non_article', reason: 'author_profile' });
});

test('known Mediapart profile, listing and topic routes are not individual posts', () => {
  const cases = [
    ['/h-sabbah/', 'author_profile'],
    ['/patrice-charoulet/blog/billets_blog', 'blog_listing'],
    ['/silexique/blog', 'blog_listing'],
    ['/pcf-lem/editions/articles', 'blog_listing'],
    ['/festival-un-week-end-l-est/blog/mot-cle/week-end-a-lest', 'topic_page'],
  ] as const;
  for (const [path, reason] of cases)
    assert.deepEqual(externalContentKind('https://blogs.mediapart.fr'+path, 'mediapart.fr'),
      { kind: 'non_article', reason });
});

test('article routes and unknown page types remain in the denominator', () => {
  const cases = [
    ['https://www.elmundo.es/espana/2026/11/12/6af57845e9cf4a3a778b457a.html', 'elmundo.es'],
    ['https://blogs.mediapart.fr/silexique/blog/121126/article-title', 'mediapart.fr'],
    ['https://www.mediapart.fr/journal/france/121126/article-title', 'mediapart.fr'],
    ['https://www.elmundo.es/internacional.html', 'elmundo.es'],
    ['https://news.google.com/rss/articles/abc', 'elmundo.es'],
    ['https://news.google.com/rss/articles/abc', 'mediapart.fr'],
  ];
  for (const [url, site] of cases)
    assert.deepEqual(externalContentKind(url!, site!), { kind: 'unknown', reason: null });
});

test('invalid URLs, wrong configured domains and lookalike hosts cannot be classified', () => {
  for (const [url, site] of [
    ['not a URL', 'mediapart.fr'],
    ['https://blogs.mediapart.fr/h-sabbah', 'elmundo.es'],
    ['https://www.elmundo.es.evil.com/e/et/eta.html', 'elmundo.es'],
    ['file:///e/et/eta.html', 'elmundo.es'],
  ]) assert.deepEqual(externalContentKind(url!, site!), { kind: 'unknown', reason: null });
});
