import type { ArticleAdapter, FetchProfile, SitePolicy } from '../packages/core/src/types.js';
import { siteDefaults } from './sites.js';
import { articleAdapters, fetchProfiles } from './profiles.js';
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
    const { domain, enabled, requestsPerMinute, fetchProfile = 'crawler', articleAdapter } = record;
    if (typeof domain !== 'string' || domain.length > 253 || !domainPattern.test(domain))
      throw new Error(`Invalid lowercase policy domain: ${domain}`);
    if (byDomain.has(domain)) throw new Error(`Duplicate policy domain: ${domain}`);
    if (typeof enabled !== 'boolean' || !Object.hasOwn(fetchProfiles, fetchProfile)
      || !Number.isInteger(requestsPerMinute) || requestsPerMinute < 1 || requestsPerMinute > siteRules.maxRequestsPerMinute)
      throw new Error(`Invalid policy for ${domain}: enabled, fetch profile or request limit`);
    if (articleAdapter !== undefined) {
      if (!Object.hasOwn(articleAdapters, articleAdapter)) throw new Error(`Unknown article adapter for ${domain}: ${articleAdapter}`);
      for (const host of articleAdapters[articleAdapter]!.hosts || []) {
        if (!domainPattern.test(host) || !(host === domain || host.endsWith(`.${domain}`)))
          throw new Error(`Invalid article adapter host for ${domain}: ${host}`);
      }
    }
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
  for (const [name, profile] of Object.entries(fetchProfiles)) {
    if (profile.impersonate !== 'chrome136' || typeof profile.defaultHeaders !== 'boolean'
      || !profile.headers || Object.entries(profile.headers).some(([key, value]) =>
        !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(key) || typeof value !== 'string' || /[\r\n]/.test(value)))
      throw new Error(`Invalid fetch profile: ${name}`);
  }
  for (const [name, profile] of Object.entries(articleAdapters)) {
    if (!['generic', 'arc-story'].includes(profile.strategy)) throw new Error(`Invalid article adapter: ${name}`);
    if (profile.publication && (!profile.publication.selector || !/^[+-]\d{2}:\d{2}$/.test(profile.publication.offset)))
      throw new Error(`Invalid publication profile: ${name}`);
    if (profile.body) {
      if (!profile.body.pathPattern || !profile.body.selector || !profile.body.remove) throw new Error(`Invalid body profile: ${name}`);
      new RegExp(profile.body.pathPattern);
    }
  }
  const domainTables = { editions, titleSuffixes, listingRoutes };
  for (const [name, table] of Object.entries(domainTables)) {
    for (const domain of Object.keys(table)) {
      if (!store.for(domain)) throw new Error(`${name}: unknown policy domain ${domain}`);
    }
  }
  const hostTables = { nonArticleHosts: Object.keys(nonArticleHosts), sourceHostPriorities: Object.keys(sourceHostPriorities) };
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

export const fetchProfileFor = (site: SitePolicy): FetchProfile => fetchProfiles[site.fetchProfile ?? 'crawler']!;

type CompiledArticleAdapter = Omit<ArticleAdapter, 'body'> & {
  body?: NonNullable<ArticleAdapter['body']> & { path: RegExp };
};
const compiledArticles = new Map<string, CompiledArticleAdapter>(Object.entries(articleAdapters).map(([name, { body, ...profile }]) => [name, {
  ...profile, ...(body ? { body: { ...body, path: new RegExp(body.pathPattern) } } : {}),
}]));

export function articleAdapterFor(url: string): CompiledArticleAdapter | undefined {
  const { hostname } = new URL(url);
  const site = policy.all().find(({ domain }) => hostname === domain || hostname.endsWith(`.${domain}`));
  const adapter = site?.articleAdapter ? compiledArticles.get(site.articleAdapter) : undefined;
  return adapter && (!adapter.hosts || adapter.hosts.includes(hostname)) ? adapter : undefined;
}
const configuredOrder = new Map(policy.all().flatMap(site =>
  (site.discoverySources || []).map((source, index) => [source.url, index] as const)));
export const configuredSourceIndex = (url: string): number => configuredOrder.get(url) ?? -1;
