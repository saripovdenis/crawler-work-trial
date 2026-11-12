// Same hardcoded transport selection as before the layout change.
export const chromeSites = new Set(['hoodline.com', 'eleconomista.es']);

// Publisher-local dates observed in archived article headers, not HTTP Date or
// page-generation comments. These publishers use China Standard Time year-round.
export const publicationProfiles: Record<string, {selector: string; attribute?: string; offset: string}> = {
  'ce.cn': {selector: 'meta[name="publishdate"]', attribute: 'content', offset: '+08:00'},
  'eastmoney.com': {selector: '#topbox .tipbox .infos > .item', offset: '+08:00'},
  // Sina news and Kandian (k.sina.com.cn) pages give this field without a zone.
  // Zoned values, as on finance pages, are still read by the generic path first.
  'sina.com.cn': {selector: 'meta[property="article:published_time"]', attribute: 'content', offset: '+08:00'},
};

// Verified Arc story JSON is archived in these publishers' article responses.
export const arcContentHosts = new Set(['www.chosun.com', 'biz.chosun.com']);

// Verified article containers in archived publisher pages. Restrict by both
// configured domain and article path; listing/forum pages retain the fallback.
export const articleBodyProfiles: Record<string, { path: RegExp; selector: string; remove: string }> = {
  'sina.com.cn': {path: /\/doc-[\w]+\.shtml$/, selector: '#artibody', remove: 'script,style,noscript,.appendQr_wrap,.article-editor'},
  'eastmoney.com': {path: /\/(?:a\/\d+|news\/\d+,\d+)\.html$/, selector: '#ContentBody', remove: 'script,style,noscript'},
};
