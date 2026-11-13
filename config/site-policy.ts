import type { SitePolicy } from '../packages/core/src/types.js';
import { siteDefaults } from './sites.js';
import { articleBodyProfiles, arcContentHosts, publicationProfiles } from './profiles.js';
import { discoverySeeds, sourceHostPriorities } from './discovery.js';
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
  for (const seed of discoverySeeds) {
    const url = new URL(seed.url);
    if (!store.for(seed.domain) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || (url.port && !['80', '443'].includes(url.port))
      || !(url.hostname === seed.domain || url.hostname.endsWith(`.${seed.domain}`)))
      throw new Error(`discoverySeeds: invalid policy domain or URL ${seed.url}`);
  }
}

// Validation runs at import, before a service can claim work. Keep the defaults'
// order: the first eligible active domain wins, exactly as in the original loop.
export const policy = createSitePolicyStore(siteDefaults);
validateSiteProfiles(policy);
