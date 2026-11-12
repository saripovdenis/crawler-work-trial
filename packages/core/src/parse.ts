import { load } from 'cheerio';
import { XMLParser } from 'fast-xml-parser';
import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { dateIso, normalizeUrl } from './policy.js';
import { sourcePriority } from '../../../config/discovery.js';
import type { Article } from './types.js';

export type Found = { url: string; published: string | null };
export type Source = { url: string; kind: string };
const list = (v: any): any[] => v == null ? [] : Array.isArray(v) ? v : [v];
const xml = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, processEntities: false });

export function discover(body: string, url: string, kind: string) {
  const articles: Found[] = [];
  const sources: Source[] = [];
  let partial = false;
  const add = (value: unknown, published: unknown = null) => {
    if (typeof value !== 'string') return;
    const next = normalizeUrl(value, url);
    if (next) articles.push({ url: next, published: dateIso(published) });
  };
  const source = (value: string, type: string) => {
    const next = normalizeUrl(value, url);
    if (next) sources.push({ url: next, kind: type });
  };
  const isHtml = /<!doctype\s+html|<html[\s>]/i.test(body.slice(0, 2000));
  if (!isHtml && (kind !== 'html' || /^\s*(?:<\?xml[^>]*>\s*)?<(?:rss|feed|urlset|sitemapindex)\b/i.test(body))) {
    let doc;
    if (/<rss\b/i.test(body.slice(0,2000)) && !/<\/rss>\s*$/i.test(body)) {
      const items = body.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/g);
      if (!items?.length) throw new Error('Truncated RSS contains no complete items');
      body = '<rss><channel>'+items.join('')+'</channel></rss>';
      partial = true;
    }
    try { doc = xml.parse(body); }
    catch (error) {
      // Some RSS servers close a successful HTTP response mid-item. Recover only
      // whole, closed items; keep the partial flag so callers retry without ETag.
      const items = body.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/g);
      if (!/<rss\b/i.test(body.slice(0,2000)) || !items?.length) throw error;
      doc = xml.parse('<rss><channel>'+items.join('')+'</channel></rss>');
      partial = true;
    }
    if (doc.sitemapindex) {
      const maps = list(doc.sitemapindex.sitemap).sort((a, b) => {
        const score = (s: any) => (sourcePriority(s.loc,'sitemap') * 1e15) + (Date.parse(s.lastmod) || 0);
        return score(b) - score(a);
      });
      for (const m of maps.slice(0, 4)) if (typeof m.loc === 'string') source(m.loc, 'sitemap');
    }
    for (const item of list(doc.urlset?.url)) {
      // lastmod is NOT a publication date.
      add(item.loc, item.news?.publication_date);
    }
    for (const item of list(doc.rss?.channel?.item)) add(item.link, item.pubDate ?? item.date);
    for (const item of list(doc.feed?.entry)) {
      const link = list(item.link).find(l => !l['@_rel'] || l['@_rel'] === 'alternate');
      add(typeof link === 'string' ? link : link?.['@_href'], item.published);
    }
    if (!doc.rss && !doc.feed && !doc.urlset && !doc.sitemapindex) throw new Error('Not a supported feed or sitemap');
  } else {
    const $ = load(body);
    $('link[rel="alternate"]').each((_, e) => {
      if (/rss|atom|xml/i.test($(e).attr('type') || '')) source($(e).attr('href') || '', 'feed');
    });
    $('a[href]').each((_, e) => {
      const href = $(e).attr('href') || '';
      if (/rss|atom|feed/i.test(href) && /(?:xml|rss|atom|feed)(?:[/?#.]|$)/i.test(href)) source(href, 'feed');
      const next = normalizeUrl(href, url);
      if (!next) return;
      const path = new URL(next).pathname;
      const text = $(e).text().trim();
      if (/\.(?:jpg|png|gif|svg|pdf|mp4|zip|css|js)$/i.test(path)) return;
      if (/\/(?:tag|tags|search|login|author|video|contact|about|privacy)(?:\/|$)/i.test(path)) return;
      if (text.length >= 8 && (/\d{5,}|\d{4}[-/]\d{2}|\.s?html?$|\/articles\//i.test(path) || path.split('/').filter(Boolean).length >= 3 || path.length > 65)) add(next);
    });
  }
  return { articles: [...new Map(articles.map(a => [a.url, a])).values()], sources, partial };
}

export function parseArticle(body: string, url: string, discovered: number, hint: string | null): Article & { dateSource: string | null; isArticle: boolean } {
  const $ = load(body);
  const meta = (key: string) => $(`meta[property="${key}"],meta[name="${key}"]`).first().attr('content')?.trim();
  let structured: any = {};
  function walk(value: any): void {
    if (!value || typeof value !== 'object') return;
    if (list(value['@type']).some(t => /(?:NewsArticle|Article|ReportageNewsArticle|BlogPosting)$/i.test(String(t)))) {
      if (value.headline || value.datePublished) structured = value;
    }
    for (const v of Object.values(value)) if (typeof v === 'object') {
      if (Array.isArray(v)) v.forEach(walk); else walk(v);
    }
  }
  $('script[type="application/ld+json"]').each((_, e) => { try { walk(JSON.parse($(e).text())); } catch {} });
  const socialTags: Record<string, string[]> = {};
  $('meta').each((_, e) => {
    const key = $(e).attr('property') || $(e).attr('name') || '';
    const value = $(e).attr('content');
    if (/^(og:|twitter:)/.test(key) && value) (socialTags[key] ??= []).push(value);
  });
  const dates = [
    ['jsonld.datePublished', structured.datePublished],
    ['article:published_time', meta('article:published_time')],
    ['datePublished', $('[itemprop="datePublished"]').attr('content')],
    ['pubdate', meta('pubdate')], ['feed', hint],
  ];
  const date = dates.map(([source, value]) => [source, dateIso(value)]).find(([, value]) => value);
  const dom = new JSDOM(body, { url, virtualConsole: new VirtualConsole() });
  let readable;
  try { readable = new Readability(dom.window.document).parse(); } finally { dom.window.close(); }
  const text = (structured.articleBody || readable?.textContent || $('article').text() || '').replace(/\s+/g, ' ').trim();
  return {
    canonicalUrl: normalizeUrl($('link[rel="canonical"]').attr('href') || url, url) || url,
    discoveredAt: new Date(discovered).toISOString(), publishedAt: date?.[1] || null,
    modifiedAt: dateIso(structured.dateModified || meta('article:modified_time')),
    title: String(structured.headline || meta('og:title') || readable?.title || $('title').text()).trim(),
    description: meta('description') || meta('og:description') || readable?.excerpt || null,
    socialTags, text, dateSource: date?.[0] || null,
    isArticle: !!structured['@type'] || meta('og:type') === 'article' || !!meta('article:published_time') || !!hint,
  };
}
