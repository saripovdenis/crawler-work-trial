import { load, type CheerioAPI } from 'cheerio';
import { XMLParser } from 'fast-xml-parser';
import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { dateIso, normalizeUrl, domainFor, isKnownListingUrl } from './policy.js';
import { sourcePriority } from '../../../config/discovery.js';
import { publicationProfiles, arcContentHosts, articleBodyProfiles } from '../../../config/profiles.js';
import type { Article } from './types.js';

export type Found = { url: string; published: string | null };
export type Source = { url: string; kind: string };
const list = (v: any): any[] => v == null ? [] : Array.isArray(v) ? v : [v];
const xml = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, processEntities: false });

export function publisherPublication($: CheerioAPI, url: string): {value: string; source: string} | null {
  const domain = domainFor(url), profile = domain && publicationProfiles[domain];
  if (!profile) return null;
  const element = $(profile.selector).first();
  const raw = (profile.attribute ? element.attr(profile.attribute) : element.text())?.trim();
  const parts = raw?.match(/^(\d{4})[-年](\d{1,2})[-月](\d{1,2})日?\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!parts) return null;
  const [,year,month,day,hour,minute,second='00'] = parts;
  const value = dateIso(`${year}-${month!.padStart(2,'0')}-${day!.padStart(2,'0')}T${hour}:${minute}:${second}${profile.offset}`);
  return value ? {value, source: `site:${domain}:${profile.selector} (${profile.offset})`} : null;
}

function publisherArticleBody($: CheerioAPI, url: string): {text: string; source: string} | null {
  const domain=domainFor(url), profile=domain && articleBodyProfiles[domain];
  if(!profile || !profile.path.test(new URL(url).pathname)) return null;
  const container=$(profile.selector).first();
  if(!container.length) return null;
  const content=container.clone();
  content.find(profile.remove).remove();
  return {text:content.text().replace(/\s+/g,' ').trim(),source:`site:${domain}:${profile.selector}`};
}

// Decode an embedded JSON value without executing publisher JavaScript.
function jsonObjectAfter(script: string, start: number): any | null {
  while (/\s/.test(script[start] || '') && start < script.length) start++;
  if (script[start] !== '{') return null;
  let depth=0, quoted=false, escape=false;
  for(let i=start;i<script.length;i++) {
    const char=script[i];
    if(quoted) {
      if(escape) escape=false;
      else if(char==='\\') escape=true;
      else if(char==='"') quoted=false;
    } else if(char==='"') quoted=true;
    else if(char==='{') depth++;
    else if(char==='}' && --depth===0) {
      try { return JSON.parse(script.slice(start,i+1)); } catch { return null; }
    }
  }
  return null;
}

function storyFromScripts(scripts: Iterable<string>, url: string): {text: string; publishedAt: string | null} | null {
  const requested=new URL(url);
  if(!arcContentHosts.has(requested.hostname)) return null;
  for(const script of scripts) {
    const marker=/(?:^|[;\s])Fusion\.globalContent\s*=/g;
    for(const match of script.matchAll(marker)) {
      const story=jsonObjectAfter(script,match.index!+match[0].length);
      if(story?.type!=='story' || !Array.isArray(story.content_elements)) continue;
      let sameCanonical=false;
      try { const canonical=new URL(story.canonical_url,url);sameCanonical=canonical.origin===requested.origin && canonical.pathname===requested.pathname; } catch {}
      const sameId=typeof story._id==='string' && requested.pathname.split('/').filter(Boolean).at(-1)===story._id;
      if(!sameId && !sameCanonical) continue;
      const paragraphs: string[]=[];
      const text=(value: unknown) => {
        if(typeof value!=='string') return;
        const fragment=load(value);fragment('script,style,noscript').remove();
        const content=fragment.text().replace(/\s+/g,' ').trim();
        if(content) paragraphs.push(content);
      };
      const visit=(items: any[], depth=0) => {
        if(depth>32) return;
        for(const item of items) {
          if(!item || typeof item!=='object') continue;
          if(['text','header'].includes(item.type)) text(item.content);
          else if(item.type==='list' && Array.isArray(item.items)) {
            for(const entry of item.items) typeof entry==='string'?text(entry):visit([entry],depth+1);
          }
          else if(['quote','blockquote'].includes(item.type) && Array.isArray(item.content_elements)) visit(item.content_elements,depth+1);
        }
      };
      visit(story.content_elements);
      // Empty verified story content must stay incomplete: navigation and image
      // captions found by Readability are not a substitute for the article body.
      return {text:paragraphs.join('\n\n'),publishedAt:dateIso(story.first_publish_date)};
    }
  }
  return null;
}

export function publisherStory($: CheerioAPI, url: string) {
  return storyFromScripts($('script').toArray().map(element=>$(element).text()),url);
}

// Archive repairs already have title/tags in SQLite. Avoid constructing the full
// publisher page DOM just to recover its embedded story JSON.
export function publisherStoryFromHtml(body: string, url: string) {
  return storyFromScripts(Array.from(body.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi),m=>m[1]!),url);
}

export function discover(body: string, url: string, kind: string) {
  const articles: Found[] = [];
  const sources: Source[] = [];
  let partial = false;
  const add = (value: unknown, published: unknown = null) => {
    if (typeof value !== 'string') return;
    const next = normalizeUrl(value, url);
    if (next && !isKnownListingUrl(next)) articles.push({ url: next, published: dateIso(published) });
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

export function parseArticle(body: string, url: string, discovered: number, hint: string | null): Article & { dateSource: string | null; isArticle: boolean; textSource: string | null } {
  const $ = load(body);
  const listing=isKnownListingUrl(url);
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
  const publisherDate = publisherPublication($, url);
  const publisher = publisherStory($,url);
  const articleBody = publisherArticleBody($,url);
  const dates = [
    ['fusion.globalContent.first_publish_date', publisher?.publishedAt],
    ['jsonld.datePublished', structured.datePublished],
    ['article:published_time', meta('article:published_time')],
    ['datePublished', $('[itemprop="datePublished"]').attr('content')],
    ['pubdate', meta('pubdate')], [publisherDate?.source, publisherDate?.value], ['feed', hint],
  ];
  const date = dates.map(([source, value]) => [source, dateIso(value)]).find(([, value]) => value);
  const publisherBody=publisher?.text ?? articleBody?.text ?? null;
  const structuredBody=typeof structured.articleBody==='string' && structured.articleBody.trim()?structured.articleBody:null;
  const knownTitle=structured.headline || meta('og:title') || (articleBody ? $('title').text().trim() : undefined);
  const knownDescription=meta('description') || meta('og:description');
  // Readability contributes only text, a fallback title and a fallback excerpt.
  // Skip its DOM when all three outputs already come from explicit metadata.
  const completeStructured=!!(structuredBody && knownTitle && knownDescription);
  let readable;
  if(!listing && ((publisherBody===null && !completeStructured) || (articleBody && (!knownTitle || !knownDescription)))) {
    const dom = new JSDOM(body, { url, virtualConsole: new VirtualConsole() });
    try { readable = new Readability(dom.window.document).parse(); } finally { dom.window.close(); }
  }
  const text = listing?'':(publisherBody ?? (structuredBody || readable?.textContent || $('article').text() || '')).replace(/\s+/g, ' ').trim();
  const textSource=listing?null:publisher?'fusion.globalContent.content_elements':articleBody?articleBody.source:structuredBody?'jsonld.articleBody':readable?.textContent?'readability':text?'article':null;
  return {
    canonicalUrl: normalizeUrl($('link[rel="canonical"]').attr('href') || url, url) || url,
    discoveredAt: new Date(discovered).toISOString(), publishedAt: date?.[1] || null,
    modifiedAt: dateIso(structured.dateModified || meta('article:modified_time')),
    title: String(knownTitle || readable?.title || $('title').text()).trim(),
    description: knownDescription || readable?.excerpt || null,
    socialTags, text, textSource, dateSource: date?.[0] || null,
    isArticle: !listing && (!!structured['@type'] || meta('og:type') === 'article' || !!meta('article:published_time') || !!publisherDate || !!publisher || !!hint),
  };
}
