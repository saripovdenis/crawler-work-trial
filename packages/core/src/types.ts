export interface SitePolicy {
  readonly domain: string;
  readonly enabled: boolean;
  readonly requestsPerMinute: number;
  readonly transport: 'node' | 'chrome136';
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
