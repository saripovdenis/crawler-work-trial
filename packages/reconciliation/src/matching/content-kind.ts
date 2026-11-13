import { domainFor } from '../../../core/src/policy.js';
import { matchingRules } from './rules.js';

export type ExternalContentKind = {
  kind: 'non_article' | 'unknown';
  reason: 'topic_page' | 'author_profile' | 'blog_listing' | 'comment_page' | null;
};
const unknown: ExternalContentKind = { kind: 'unknown', reason: null };

// Only known publisher route shapes establish a negative classification.
// Headlines, provider dates and Google wrapper URLs do not establish page type.
// "unknown" must never be silently excluded from a coverage denominator.
// sourceHost is the host the provider itself names as the row's source; a
// Google wrapper link hides the URL, but its feed states that host.
export function externalContentKind(raw: string, site: string, sourceHost?: string | null): ExternalContentKind {
  const host = (sourceHost || '').toLowerCase();
  if (host && domainFor('https://' + host + '/') === site && matchingRules.nonArticleHosts[host])
    return { kind: 'non_article', reason: matchingRules.nonArticleHosts[host]! };
  return routeKind(raw, site);
}

// A sample group is a non-article only when every row in it is one. A direct
// article link grouped with a comment-page row keeps the group in the sample.
export function groupContentKind(group: { site: string; provider_timings: { url: string; source_host?: string | null }[] }): ExternalContentKind {
  let found: ExternalContentKind | null = null;
  for (const row of group.provider_timings) {
    const kind = externalContentKind(row.url, group.site, row.source_host);
    if (kind.kind !== 'non_article') return unknown;
    found ??= kind;
  }
  return found ?? unknown;
}

function routeKind(raw: string, site: string): ExternalContentKind {
  let url: URL;
  try { url = new URL(raw); } catch { return unknown; }
  if (domainFor(url.href) !== site) return unknown;
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const host = url.hostname.replace(/^www\./, '');
  if (site === 'elmundo.es' && host === 'elmundo.es') {
    // Confirmed by topic and byline links in archived El Mundo articles.
    if (/^\/e\/[a-z0-9]{2}\/[^/]+\.html$/i.test(path))
      return { kind: 'non_article', reason: 'topic_page' };
    if (/^\/autor\/[^/]+\.html$/i.test(path))
      return { kind: 'non_article', reason: 'author_profile' };
  }
  if (site === 'mediapart.fr' && host === 'blogs.mediapart.fr') {
    // Club posts have a date and slug after /<author>/blog/; these shorter
    // routes and topic/edition indexes are navigation, not individual posts.
    if (/^\/[^/]+$/.test(path))
      return { kind: 'non_article', reason: 'author_profile' };
    if (/^\/[^/]+\/blog(?:\/billets_blog)?$/.test(path)
      || /^\/[^/]+\/editions\/articles$/.test(path))
      return { kind: 'non_article', reason: 'blog_listing' };
    if (/^\/[^/]+\/blog\/mot-cle\/[^/]+$/.test(path))
      return { kind: 'non_article', reason: 'topic_page' };
  }
  return unknown;
}
