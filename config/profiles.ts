import type { ArticleProfile, FetchProfile } from '../packages/core/src/types.js';

// Plain JSON-compatible values: no functions, RegExp or Set instances.
// Both profiles use Python curl_cffi; only their HTTP headers differ.
export const fetchProfiles: Readonly<Record<string, FetchProfile>> = {
  crawler: {
    impersonate: 'chrome136',
    defaultHeaders: false,
    headers: {
      'User-Agent': 'ExaTrialCrawler/0.1',
      Accept: 'text/html,application/xml,application/rss+xml,*/*;q=0.5',
    },
  },
  chrome: {
    impersonate: 'chrome136',
    defaultHeaders: true,
    headers: {},
  },
};

// Generic extraction always reads JSON-LD/OpenGraph and uses Readability as needed.
// Named overrides retain the selectors and host scopes verified in saved HTML.
export const articleProfiles: Readonly<Record<string, ArticleProfile>> = {
  generic: { strategy: 'generic' },
  'sina-article': {
    strategy: 'generic',
    publication: { selector: 'meta[property="article:published_time"]', attribute: 'content', offset: '+08:00' },
    body: {
      pathPattern: '/doc-[\\w]+\\.shtml$',
      selector: '#artibody',
      remove: 'script,style,noscript,.appendQr_wrap,.article-editor',
    },
  },
  'eastmoney-article': {
    strategy: 'generic',
    publication: { selector: '#topbox .tipbox .infos > .item', offset: '+08:00' },
    body: {
      pathPattern: '/(?:a/\\d+|news/\\d+,\\d+)\\.html$',
      selector: '#ContentBody',
      remove: 'script,style,noscript',
    },
  },
  'ce-article': {
    strategy: 'generic',
    publication: { selector: 'meta[name="publishdate"]', attribute: 'content', offset: '+08:00' },
  },
  'arc-story': { strategy: 'arc-story' },
};
