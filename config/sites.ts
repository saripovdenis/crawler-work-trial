import type { SitePolicy } from '../packages/core/src/types.js';

// Each domain and all of its subdomains share one request budget.
export const siteDefaults: readonly SitePolicy[] = [
  { domain: 'sina.com.cn', requestsPerMinute: 30, enabled: true, transport: 'node' },
  { domain: 'indiatimes.com', requestsPerMinute: 15, enabled: true, transport: 'node' },
  { domain: 'chosun.com', requestsPerMinute: 10, enabled: true, transport: 'node' },
  { domain: 'antaranews.com', requestsPerMinute: 10, enabled: true, transport: 'node' },
  { domain: 'bbc.com', requestsPerMinute: 5, enabled: true, transport: 'node' },
  { domain: 'hoodline.com', requestsPerMinute: 5, enabled: true, transport: 'chrome136' },
  { domain: 'udn.com', requestsPerMinute: 5, enabled: true, transport: 'node' },
  { domain: 'hurriyet.com.tr', requestsPerMinute: 5, enabled: true, transport: 'node' },
  { domain: 'haberturk.com', requestsPerMinute: 5, enabled: true, transport: 'node' },
  { domain: 'youm7.com', requestsPerMinute: 3, enabled: true, transport: 'node' },
  { domain: 'eastmoney.com', requestsPerMinute: 3, enabled: true, transport: 'node' },
  { domain: 'eldiario.es', requestsPerMinute: 3, enabled: true, transport: 'node' },
  { domain: 'ce.cn', requestsPerMinute: 3, enabled: true, transport: 'node' },
  { domain: 'cnnbrasil.com.br', requestsPerMinute: 2, enabled: true, transport: 'node' },
  { domain: 'biobiochile.cl', requestsPerMinute: 2, enabled: true, transport: 'node' },
  { domain: 'elmundo.es', requestsPerMinute: 2, enabled: true, transport: 'node' },
  { domain: 'mediapart.fr', requestsPerMinute: 2, enabled: true, transport: 'node' },
  { domain: 'eleconomista.es', requestsPerMinute: 2, enabled: true, transport: 'chrome136' },
  { domain: 'newindianexpress.com', requestsPerMinute: 2, enabled: true, transport: 'node' },
  { domain: 'zaobao.com.sg', requestsPerMinute: 2, enabled: true, transport: 'node' },
];
