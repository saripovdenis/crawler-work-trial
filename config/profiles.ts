// Same hardcoded transport selection as before the layout change.
export const chromeSites = new Set(['hoodline.com', 'eleconomista.es']);

// Publisher-local dates observed in archived article headers, not HTTP Date or
// page-generation comments. These publishers use China Standard Time year-round.
export const publicationProfiles: Record<string, {selector: string; attribute?: string; offset: string}> = {
  'ce.cn': {selector: 'meta[name="publishdate"]', attribute: 'content', offset: '+08:00'},
  'eastmoney.com': {selector: '#topbox .tipbox .infos > .item', offset: '+08:00'},
};
