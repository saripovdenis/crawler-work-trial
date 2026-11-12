import { domainFor } from '../../core/src/policy.js';

export type ExternalContentKind = {
  kind: 'non_article' | 'unknown';
  reason: 'topic_page' | 'author_profile' | 'blog_listing' | null;
};

// Only known publisher route shapes establish a negative classification.
// Headlines, provider dates and Google wrapper URLs do not establish page type.
// "unknown" must never be silently excluded from a coverage denominator.
export function externalContentKind(raw: string, site: string): ExternalContentKind {
  const unknown: ExternalContentKind = { kind: 'unknown', reason: null };
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
