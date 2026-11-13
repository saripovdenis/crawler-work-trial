import type { SitePolicy } from '../packages/core/src/types.js';
import { siteDefaults } from './sites.js';
import { articleBodyProfiles, arcContentHosts, publicationProfiles } from './profiles.js';
import { sourceHostPriorities } from './discovery.js';
import { editions } from './monitor.js';
import { listingRoutes, nonArticleHosts, titleSuffixes } from './article-rules.js';

export type { SitePolicy };

// Preserve the trial's existing limits and conservative dispatch spacing.
export const siteRules = Object.freeze({
  maxRequestsPerMinute: 60,
  windowMs: 60_000,
  warmupMs: 600_000,
  warmupRequestsPerMinute: 60,
  spacingMarginMs: 20,
  // Five seconds to dispatch + 25s transport cap + five seconds of margin.
  inFlightReserveMs: 35_000,
});

export interface SitePolicyStore {
  for(domain: string): SitePolicy | undefined;
  all(): readonly SitePolicy[];
  active(): readonly SitePolicy[];
}

const domainPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function createSitePolicyStore(records: readonly SitePolicy[]): SitePolicyStore {
  const byDomain = new Map<string, SitePolicy>();
  for (const record of records) {
    const { domain, enabled, requestsPerMinute, transport } = record;
    if (typeof domain !== 'string' || domain.length > 253 || !domainPattern.test(domain))
      throw new Error(`Invalid lowercase policy domain: ${domain}`);
    if (byDomain.has(domain)) throw new Error(`Duplicate policy domain: ${domain}`);
    if (typeof enabled !== 'boolean' || !['node', 'chrome136'].includes(transport)
      || !Number.isInteger(requestsPerMinute) || requestsPerMinute < 1 || requestsPerMinute > siteRules.maxRequestsPerMinute)
      throw new Error(`Invalid policy for ${domain}: enabled, transport or request limit`);
    const sources = new Set<string>();
    for (const source of record.discoverySources || []) {
      const url = new URL(source.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash
        || (url.port && !['80', '443'].includes(url.port))
        || !(url.hostname === domain || url.hostname.endsWith(`.${domain}`))
        || !['sitemap', 'feed', 'html', 'api'].includes(source.kind)
        || (source.kind === 'api' && source.adapter !== 'sina-roll') || sources.has(source.url))
        throw new Error(`Invalid or duplicate discovery source for ${domain}: ${source.url}`);
      if (source.kind === 'api' && (url.hostname !== 'feed.mix.sina.com.cn' || url.pathname !== '/api/roll/get'))
        throw new Error(`sina-roll requires Sina's rolling API: ${source.url}`);
      sources.add(source.url);
    }
    for (const other of byDomain.keys()) {
      if (domain.endsWith(`.${other}`) || other.endsWith(`.${domain}`))
        throw new Error(`Overlapping policy domains: ${domain}, ${other}`);
    }
    byDomain.set(domain, Object.freeze({ ...record }));
  }
  const all = Object.freeze([...byDomain.values()]);
  const active = Object.freeze(all.filter(record => record.enabled));
  return Object.freeze({ for: (domain: string) => byDomain.get(domain), all: () => all, active: () => active });
}

export function validateSiteProfiles(store: SitePolicyStore): void {
  const domainTables = { publicationProfiles, articleBodyProfiles, editions, titleSuffixes, listingRoutes };
  for (const [name, table] of Object.entries(domainTables)) {
    for (const domain of Object.keys(table)) {
      if (!store.for(domain)) throw new Error(`${name}: unknown policy domain ${domain}`);
    }
  }
  const hostTables = { arcContentHosts: [...arcContentHosts], nonArticleHosts: Object.keys(nonArticleHosts), sourceHostPriorities: Object.keys(sourceHostPriorities) };
  for (const [name, hosts] of Object.entries(hostTables)) {
    for (const host of hosts) {
      if (!domainPattern.test(host) || !store.all().some(({ domain }) => host === domain || host.endsWith(`.${domain}`)))
        throw new Error(`${name}: unknown policy host ${host}`);
    }
  }
}

// Validation runs at import, before a service can claim work. Keep the defaults'
// order: the first eligible active domain wins, exactly as in the original loop.
export const policy = createSitePolicyStore(siteDefaults);
validateSiteProfiles(policy);
const configuredOrder = new Map(policy.all().flatMap(site =>
  (site.discoverySources || []).map((source, index) => [source.url, index] as const)));
export const configuredSourceIndex = (url: string): number => configuredOrder.get(url) ?? -1;
