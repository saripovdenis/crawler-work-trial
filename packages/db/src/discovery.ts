import type { DatabaseSync } from '../../pg/src/sync.js';
import type { SitePolicy } from '../../core/src/types.js';

// Config changes update parsing metadata only. Existing due times, validators,
// counters, leases and request charges remain owned by the database.
export function seedDiscovery(db: DatabaseSync, sites: readonly SitePolicy[], now: number) {
  const addSite = db.prepare('INSERT OR IGNORE INTO sites(domain,started) VALUES (?,?)');
  const addSource = db.prepare(`INSERT INTO sources(url,domain,kind) VALUES (?,?,?)
    ON CONFLICT(url) DO UPDATE SET kind=excluded.kind
    WHERE sources.domain=excluded.domain AND sources.kind<>excluded.kind`);
  for (const site of sites) {
    addSite.run(site.domain, now);
    const sources = site.discoverySources?.length ? site.discoverySources
      : [{kind: 'html' as const, url: `https://www.${site.domain}/`}];
    for (const source of sources)
      addSource.run(source.url, site.domain, source.kind === 'api' ? `api:${source.adapter}` : source.kind);
  }
}
