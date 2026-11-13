export type DiscoverySource = { readonly url: string; readonly pollEveryMs?: number } & (
  | { readonly kind: 'sitemap' | 'rss' | 'feed' }
  | { readonly kind: 'html'; readonly adapter?: string }
  | { readonly kind: 'api'; readonly adapter: 'sina-roll' }
);

export interface DiscoveryScheduling {
  readonly articleWeight: number;
  readonly discoveryWeight: number;
}

export interface HtmlDiscoveryAdapter {
  readonly articleLinks: string;
  readonly paginationLinks?: string;
}

export interface SiteConfig {
  readonly domain: string;
  readonly requestsPerMinute: number;
  readonly fetchProfile?: string;
  readonly articleAdapter?: string;
  readonly seeds?: readonly DiscoverySource[];
  readonly scheduling?: DiscoveryScheduling;
}

// Keep the scheduler/worker contract stable; every configured site is active.
export interface SitePolicy extends SiteConfig {
  readonly enabled: boolean;
}

// JSON-compatible configuration, also sent unchanged to the Python HTTP client.
export interface FetchProfile {
  readonly impersonate: 'chrome136';
  readonly defaultHeaders: boolean;
  readonly headers: Readonly<Record<string, string>>;
}

export interface ArticleAdapter {
  readonly strategy: 'generic' | 'arc-story';
  readonly hosts?: readonly string[];
  readonly publication?: { readonly selector: string; readonly attribute?: string; readonly offset: string };
  readonly body?: { readonly pathPattern: string; readonly selector: string; readonly remove: string };
}

export interface Article {
  canonicalUrl: string;
  discoveredAt: string;
  publishedAt: string | null;
  modifiedAt: string | null;
  title: string;
  description: string | null;
  socialTags: Record<string, string[]>;
  text: string;
}
