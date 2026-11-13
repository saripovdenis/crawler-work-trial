// Reviewed publisher-specific rules. Domain/host keys are validated at startup.
export const titleSuffixes: Record<string, RegExp> = {
  'haberturk.com': /(?:\s+-\s+[^-]{1,80} Haber(?:ler|leri)?)?\s+-\s+Habert[üu]rk(?: Yerel Haberler| Son Dakika Haber| Haberler)?\s*$/iu,
  'eastmoney.com': /\s*[_|–—-]\s*东方财富网\s*$/u,
  'ce.cn': /\s*[_|–—-]\s*中国经济网(?:——国家经济门户)?\s*$/u,
  'sina.com.cn': /\s*[_|–—-]\s*新浪(?:财经|网|新闻)(?:[_|–—-]新浪网)?\s*$/u,
  'indiatimes.com': /\s+[|–—-]\s+(?:Times of India|The Economic Times|IndiaTimes|Indiatimes)(?:\s+News)?\s*$/iu,
  'bbc.com': /\s+[|–—-]\s+BBC(?: News)?\s*$/iu,
  'antaranews.com': /\s+[|–—-]\s+ANTARA(?: News)?\s*$/iu,
};

export const listingRoutes: Record<string, RegExp> = {
  'biobiochile.cl': /^\/lista(?:\/|$)/,
};

export const nonArticleHosts: Record<string, 'comment_page'> = {
  'comment5.news.sina.com.cn': 'comment_page',
};
