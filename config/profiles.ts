import type { ArticleAdapter, FetchProfile } from '../packages/core/src/types.js';

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
// Optional article adapters retain the selectors and scopes verified in saved HTML.
// Discovery adapters are separate: see each seeds entry and discovery-api.ts.
export const articleAdapters: Readonly<Record<string, ArticleAdapter>> = {
  sina: {
    strategy: 'generic',
    publication: { selector: 'meta[property="article:published_time"]', attribute: 'content', offset: '+08:00' },
    body: {
      pathPattern: '/doc-[\\w]+\\.shtml$',
      selector: '#artibody',
      remove: 'script,style,noscript,.appendQr_wrap,.article-editor',
    },
  },
  eastmoney: {
    strategy: 'generic',
    publication: { selector: '#topbox .tipbox .infos > .item', offset: '+08:00' },
    body: {
      pathPattern: '/(?:a/\\d+|news/\\d+,\\d+)\\.html$',
      selector: '#ContentBody',
      remove: 'script,style,noscript',
    },
  },
  ce: {
    strategy: 'generic',
    publication: { selector: 'meta[name="publishdate"]', attribute: 'content', offset: '+08:00' },
  },
  chosun: { strategy: 'arc-story', hosts: ['www.chosun.com', 'biz.chosun.com'] },
};
