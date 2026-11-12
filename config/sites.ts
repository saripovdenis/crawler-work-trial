import type { SiteConfig } from '../packages/core/src/types.js';

// Each domain and all of its subdomains share one request budget.
export const setup = { durationSeconds: 600, requestsPerSecond: 1 } as const;

export const sites: readonly SiteConfig[] = [
  { domain: 'sina.com.cn', requestsPerMinute: 30 },
  { domain: 'indiatimes.com', requestsPerMinute: 15 },
  { domain: 'chosun.com', requestsPerMinute: 10 },
  { domain: 'antaranews.com', requestsPerMinute: 10 },
  { domain: 'bbc.com', requestsPerMinute: 5 },
  { domain: 'hoodline.com', requestsPerMinute: 5 },
  { domain: 'udn.com', requestsPerMinute: 5 },
  { domain: 'hurriyet.com.tr', requestsPerMinute: 5 },
  { domain: 'haberturk.com', requestsPerMinute: 5 },
  { domain: 'youm7.com', requestsPerMinute: 3 },
  { domain: 'eastmoney.com', requestsPerMinute: 3 },
  { domain: 'eldiario.es', requestsPerMinute: 3 },
  { domain: 'ce.cn', requestsPerMinute: 3 },
  { domain: 'cnnbrasil.com.br', requestsPerMinute: 2 },
  { domain: 'biobiochile.cl', requestsPerMinute: 2 },
  { domain: 'elmundo.es', requestsPerMinute: 2 },
  { domain: 'mediapart.fr', requestsPerMinute: 2 },
  { domain: 'eleconomista.es', requestsPerMinute: 2 },
  { domain: 'newindianexpress.com', requestsPerMinute: 2 },
  { domain: 'zaobao.com.sg', requestsPerMinute: 2 },
];
