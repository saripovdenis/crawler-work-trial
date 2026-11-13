# Site policies

`config/sites.ts` holds one typed `SiteConfig` per configured domain:

```ts
{
  domain: 'hoodline.com', requestsPerMinute: 5,
  fetchProfile: 'chrome',
  seeds: [{ kind: 'rss', url: 'https://hoodline.com/rss', pollEveryMs: 120_000 }],
}
```

Only `config/site-policy.ts` imports those defaults. Other modules use:

- `policy.for(domain)`: exact configured domain, or `undefined`.
- `policy.active()`: configured domains, in file order (the existing claim tie-break).
- `policy.all()`: configured domains, for history and parsing.

All 20 limits are unchanged. All configured domains are active. Subdomains share
their configured parent domain's budget and fetch profile. Every publisher HTTP
request goes through the Python curl_cffi worker, which also owns claims, archives,
durable receipts and mirror uploads. The existing service is replaced, not split.
The policy layer supplies `enabled: true` internally to preserve the scheduler/worker
contract. This field is not part of site configuration. Unknown domains remain blocked.

## Validation

Importing the policy validates unique lowercase DNS names, no parent/child domain
overlaps, known profile names, and integer limits from 1
through the global ceiling of 60 requests/minute. The scheduler imports it before
opening the database. Invalid policies fail startup.

Article adapter selectors and host scopes, discovery seeds and host priorities, Google
editions, title suffixes and non-article hosts/routes must reference configured
domains. Seed URLs must belong to their named domain. Both `sites.ts` and
`profiles.ts` export plain JSON-compatible data: no functions, RegExp instances or
Sets. The policy layer validates and compiles regex strings. Extraction implementations
remain code. The static boundary check rejects imports of raw defaults
outside the policy module.

## Fetch defaults and article adapters

`fetchProfile` optionally selects a definition in `fetchProfiles`. Omit it for
`crawler`; only the two browser-header exceptions need it in `sites.ts`:

- `crawler`: Chrome 136 network fingerprint, `ExaTrialCrawler/0.1` user agent,
  existing crawler Accept header, no default browser headers.
- `chrome`: same fingerprint, curl_cffi's default Chrome headers. Hoodline and
  El Economista retain this selection.

The worker loads enabled domains and legacy profiles from the loopback-only
`GET /internal/worker-config` endpoint at startup; it does not read TypeScript or
maintain a second site list. The scheduler snapshots the full fetch profile into `assignment.fetch_profile`
when reserving a request. Per-request ETag/Last-Modified headers are applied on top.
All new assignments use `transport: 'curl_cffi'`. Old `node`/`chrome136` receipts
remain readable; an undispatched old receipt uses Python with equivalent header
selection. A dispatched receipt is never replayed. Limits, deadlines, retries and
redirect accounting are unchanged.

Article extraction defaults to the existing JSON-LD/OpenGraph/Readability pipeline.
No `generic` entry or array is needed. Optional `articleAdapter` selects one of the
JSON-compatible `articleAdapters` in `profiles.ts`: `sina`, `eastmoney`, `ce` or
`chosun`. The first three preserve the existing publication/body overrides; Chosun
uses `arc-story` only for its verified `www.chosun.com` and `biz.chosun.com` hosts.
Outside those hosts, generic extraction still runs. Open Graph/Twitter extraction
continues for every article. These hints do not claim every template is complete.

The three stages stay separate:

1. Python downloads and archives raw bytes plus HTTP metadata.
2. Discovery uses generic HTML, RSS/Atom or sitemap readers. An unusual API needs a
   named discovery adapter, such as `sina-roll`, which emits article URLs.
3. Article pages use generic extraction plus an optional article adapter. A
   discovery adapter never chooses the article extraction rules or sends requests.

Fetch headers, request limits and host scopes remain independent of seed scheduling.
Parser cache keys include config and source files, so a changed discovery profile
invalidates extraction caches; articles are not refetched just to warm them.

## Seeds

`seeds` is an optional ordered list on each site. Supported kinds are
`sitemap` (including news sitemaps and indexes), `rss` (RSS/Atom), `html`
with an optional named adapter, and `api` with a required named adapter. Legacy
`feed` configuration and stored rows remain supported as an alias for `rss`. For example:

```ts
{
  domain: 'sina.com.cn', requestsPerMinute: 30,
  articleAdapter: 'sina',
  seeds: [
    { kind: 'api', adapter: 'sina-roll', url: 'https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2509&num=50&page=1' },
    { kind: 'html', url: 'https://finance.sina.com.cn/roll/c/51894.shtml' },
  ],
}
```

The scheduler seeds these URLs into `sources`; sites with no configured sources
start at `https://www.<domain>/`. Sources participate in the same weighted scheduling from their first attempt.
Oldest-due discovery tasks run first; source score and seed order break ties.
Robots checks, request limits, cooldowns and existing leases still apply. Sources
already polled or failed resume their stored schedule; restarting does not replay a bootstrap.
Old and automatically discovered source rows remain available. Removing a seed
from config does not delete its stored source or history.

Sina's general and AI rolling feeds use `sina-roll`, which reads `result.data`,
deduplicates publisher URLs and returns them to the normal article queue. Full
pages also discover the next page, up to page 3. Those pages use the same budget,
source count/depth limits and recurring polling policy; there is no HTTP in the
adapter. `ctime`, `mtime` and `intime` are not treated as publication dates.
The article parser establishes publication evidence. Invalid API responses fail
parsing; partially valid lists remain retryable and are not cached as complete.

The adapter is stored as `api:sina-roll` in the existing `sources.kind` column,
including on discovered pagination URLs. No schema change is needed. Reseeding
only updates source kinds; it preserves due times, counters, validators and budget
history. URLs must belong to their configured domain, with no embedded credentials
or nonstandard ports. API adapters are an explicit code allowlist.

These are discovery seeds, not a completeness oracle. Future source detection can
populate the same source registry and use the same budgeted fetch path.

### Source review, 2026-11-13

All 20 entries now have explicit sources. Existing successful source records were
preferred over guessed feed URLs; no crawler was run against publishers for validation.
Large historical maps were excluded from the starting list. The complete URLs
are in `config/sites.ts`.

| Domain | Starting sources | Evidence / limit |
| --- | --- | --- |
| sina.com.cn | Rolling APIs + finance rolling HTML + news/finance homepages | Existing configured sources; no site-wide completeness guarantee |
| indiatimes.com | TOI today's sitemap + ET latest RSS + both homepages | TOI source in live DB; ET feed linked from its official RSS directory |
| chosun.com | RSS + main and business news sitemaps | Sitemaps already discover articles; RSS added below |
| antaranews.com | Latest RSS | Official RSS directory and successful DB source |
| bbc.com | News sitemap index | Existing seed; its child news maps discover articles |
| hoodline.com | RSS | Existing successful source; avoids www redirect |
| udn.com | RSS + Google News sitemap | Existing discovered RSS now configured explicitly |
| hurriyet.com.tr | RSS + breaking-news HTML | RSS added below |
| haberturk.com | RSS + general and local recent-news sitemaps | RSS added below |
| youm7.com | Homepage | Section RSS has repeated redirects/partial responses; not preferred |
| eastmoney.com | Important-news and domestic-economy HTML | Existing seeds; legacy gzip maps are stale |
| eldiario.es | RSS + Google News sitemap | Existing discovered RSS now configured explicitly |
| ce.cn | Homepage | Existing successful discovery; no better current feed verified |
| cnnbrasil.com.br | Admin-host RSS + news sitemap | RSS added below |
| biobiochile.cl | RSS and news sitemap | Existing successful sources; freshness can differ |
| elmundo.es | RSS + all-news sitemap | Existing discovered RSS now configured explicitly; opaque sitemap name may change |
| mediapart.fr | RSS + homepage + editor-choice news sitemap | Deliberately partial; section/archive maps remain discoverable |
| eleconomista.es | News sitemap | Existing successful source with browser headers |
| newindianexpress.com | News sitemap | Existing successful source |
| zaobao.com.sg | Realtime listing + homepage | Publisher's current listing; new seed needs live-run observation |

Publisher references: [ANTARA RSS](https://www.antaranews.com/rss/),
[ET RSS directory](https://economictimes.indiatimes.com/rss.cms),
[Zaobao realtime](https://www.zaobao.com.sg/realtime).

## Shared budget calculation

`siteRules` defines a 10-minute warm-up (60/min), 20ms spacing margin and
35-second uncertain-dispatch reserve. Rate spacing uses actual worker send times.
After warm-up, a 60.02-second pause drains the faster traffic before the lower cap.

The indexed `sites.next_available_at` is the scheduler's rate gate. The request
ledger remains the audit trail; eligibility no longer scans its recent rows.
`siteAvailableAt()` applies the warm-up boundary for both scheduler and dashboard.
Active leases and per-origin `budget_origins` robots delays can postpone dispatch.

Policies still use the same accessor interface. Ports, processes and environment
variables are unchanged. See `docs/POSTGRES.md` for the budget migration.

## RSS seeds and polling allocation

Every configured seed has `pollEveryMs`, a minimum interval between completed
fetches. The next due time is computed from the response finish time and persisted
in `sources.next_poll` and `crawl_tasks.next_crawl_at`. A pending parse, budget
constraint, backoff or low-yield source cooldown can delay it further. Configured
interval changes apply after the next completed poll; deployment does not reset
existing due times or active leases. Auto-discovered sources keep the existing
rate-dependent interval (at least 30 seconds, twice that for sitemaps).

Each site can override `scheduling: { articleWeight: 3, discoveryWeight: 1 }`.
Those are also the shared defaults. Weights must be integers from 1 to 100;
`pollEveryMs` must be an integer from 1 second through 7 days.

When both queues have eligible work, the scheduler targets three article requests
then one discovery request. When a queue is empty, the other borrows capacity but
discovery still waits for its due time. This is a scheduling target, not a second
rate limit. Mandatory robots work can change the observed short-term ratio.

The turn cursor is stored in PostgreSQL `meta` as `discovery-turn:<domain>` and
advances atomically with the request reservation, including failures and redirect
hops. Robots requests count toward their parent's category. Duplicate claims and
parsing completions do not consume turns. The old `scheduler_domains` counter is
retained for compatibility and no longer chooses the request category. All HTTP
attempts still use the existing single per-domain budget and robots delay.

New explicit RSS seeds (some URLs were already auto-discovered):

| Domain | RSS URL | Minimum interval |
| --- | --- | --- |
| chosun.com | https://www.chosun.com/arc/outboundfeeds/rss/?outputType=xml | 1 minute |
| udn.com | https://udn.com/news/rssfeed | 2 minutes |
| hurriyet.com.tr | https://www.hurriyet.com.tr/rss/anasayfa | 2 minutes |
| haberturk.com | https://www.haberturk.com/rss/manset.xml | 2 minutes |
| eldiario.es | https://www.eldiario.es/rss/ | 3 minutes |
| cnnbrasil.com.br | https://admin.cnnbrasil.com.br/feed/ | 3 minutes |
| elmundo.es | https://www.elmundo.es/rss/googlenews/portada.xml | 3 minutes |
| mediapart.fr | https://www.mediapart.fr/articles/feed | 5 minutes |

IndiaTimes, Antara, Hoodline and BioBioChile retain their existing feeds under
`rss`. BBC's feed is on an unconfigured parent domain (`bbci.co.uk`), so it is not
added. Sina's tested RSS was stale, Youm7's was malformed, and El Economista's was
blocked in the feed review; existing sources remain in place for them.

The intervals are starting values, not completeness guarantees: small feeds can
roll over before the next affordable poll. Monitor new articles per poll, oldest
retained entry, actual time between successful polls, and the article backlog.

Optional HTML adapters live in `config/profiles.ts` as `htmlDiscoveryAdapters`.
Each entry specifies CSS selectors `articleLinks` and optional `paginationLinks`;
selected elements must carry `href`. A seed references the entry by name, stored
as `html:<name>` in `sources.kind`. Pagination returns source URLs to the scheduler
and never performs HTTP in the parser. No HTML adapter is enabled by default.
Sitemap/RSS parsing and generic HTML discovery need no custom adapter.
