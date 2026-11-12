import test from 'node:test';
import assert from 'node:assert/strict';
import { nextAllowed, domainFor, classify, dateIso } from './policy.js';
import { discover, parseArticle, publisherStoryFromHtml } from './parse.js';

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

test('publisher-local publication fields use explicit site profiles, not generation or HTTP dates',()=>{
  const body='<html><head><title>A sufficiently long test headline</title></head><body><!--published at 2026/11/12 16:42:33 by server--><div id="topbox"><div class="tipbox"><div class="infos"><div class="item">2026年11月12日 16:27</div></div></div></div><article>'+('Article content. '.repeat(30))+'</article></body></html>';
  const east=parseArticle(body,'https://finance.eastmoney.com/a/test.html',Date.now(),null);
  assert.equal(east.publishedAt,'2026-11-12T08:27:00.000Z');assert.equal(east.isArticle,true);assert.match(east.dateSource!,/\+08:00/);
  assert.equal(parseArticle(body,'https://bbc.com/news/test',Date.now(),null).publishedAt,null);
  const ce=parseArticle('<meta name="publishdate" content="2026-11-12 16:30:09"><article>'+('Some news text. '.repeat(30))+'</article>','http://finance.ce.cn/test.shtml',Date.now(),null);
  assert.equal(ce.publishedAt,'2026-11-12T08:30:09.000Z');assert.equal(ce.isArticle,true);
});

test('Chosun parses verified embedded story text without executing JavaScript or using navigation',()=>{
  const url='https://www.chosun.com/english/national-en/2026/11/12/STORYID/';
  const paragraph='The court described a "quoted } phrase" and a \\literal path in its evidence. '.repeat(5);
  const story={_id:'STORYID',type:'story',canonical_url:new URL(url).pathname,first_publish_date:'2026-11-12T08:01:00Z',display_date:'2030-01-01T00:00:00Z',content_elements:[
    {type:'image',caption:'An image caption must not become article text'},
    {type:'text',content:'<p>'+paragraph+'</p>'},
    {type:'list',items:[{type:'text',content:'A list item &amp; its details.'}]},
    {type:'quote',content_elements:[{type:'text',content:'A quoted statement.'}]},
  ]};
  const page='<head><meta property="og:title" content="Court evidence ruling"><script type="application/ld+json">'+JSON.stringify({'@type':'NewsArticle',datePublished:'2026-11-12T08:00:00Z'})+'</script></head><body><nav>'+('Navigation filler '.repeat(50))+'</nav><script>Fusion.globalContent='+JSON.stringify(story)+';throw new Error("Never execute publisher JavaScript");</script></body>';
  const parsed=parseArticle(page,url,Date.now(),null);
  assert.equal(parsed.textSource,'fusion.globalContent.content_elements');
  assert.ok(parsed.text.includes('quoted } phrase'));assert.ok(parsed.text.includes('literal path'));
  assert.ok(parsed.text.includes('A list item & its details.'));assert.ok(parsed.text.endsWith('A quoted statement.'));
  assert.equal(parsed.text.includes('Navigation filler'),false);assert.equal(parsed.text.includes('image caption'),false);
  assert.equal(parsed.publishedAt,'2026-11-12T08:01:00.000Z');assert.equal(parsed.dateSource,'fusion.globalContent.first_publish_date');assert.equal(parsed.title,'Court evidence ruling');
  const emptyPage=page.replace(JSON.stringify(story),JSON.stringify({...story,content_elements:[]}));
  assert.equal(parseArticle(emptyPage,url,Date.now(),null).text,'');
  const wrongPage=page.replace(JSON.stringify(story),JSON.stringify({...story,_id:'OTHER',canonical_url:'/another-story/'}));
  assert.notEqual(parseArticle(wrongPage,url,Date.now(),null).textSource,'fusion.globalContent.content_elements');
  assert.notEqual(parseArticle(page,'https://bbc.com/english/STORYID/',Date.now(),null).textSource,'fusion.globalContent.content_elements');
});

test('empty JSON-LD articleBody falls back to rendered article text outside publisher profiles',()=>{
  const text='A reported article paragraph with enough content for extraction. '.repeat(8);
  const page='<html><head><title>Reported news</title><script type="application/ld+json">{"@type":"NewsArticle","headline":"Reported news","articleBody":"","datePublished":"2026-11-12T08:00:00Z"}</script></head><body><article><p>'+text+'</p></article></body></html>';
  assert.equal(parseArticle(page,'https://bbc.com/news/test',Date.now(),null).text,text.trim());
});

test('direct archive story extraction matches normal parsing without executing script text',()=>{
  const url='https://www.chosun.com/news/ABC123/';
  const story={_id:'ABC123',type:'story',first_publish_date:'2026-11-12T08:00:00Z',content_elements:[{type:'text',content:'<p>'+('Original article text. '.repeat(20))+'</p>'}]};
  const html='<html><head><title>Story</title></head><body><script>Fusion.globalContent='+JSON.stringify(story)+'; throw new Error("must not execute")</script></body></html>';
  const fast=publisherStoryFromHtml(html,url)!;
  assert.equal(fast.text,parseArticle(html,url,Date.now(),null).text);
  assert.equal(fast.publishedAt,'2026-11-12T08:00:00.000Z');
  assert.equal(publisherStoryFromHtml(html,'https://www.chosun.com/news/DIFFERENT/'),null);
});
