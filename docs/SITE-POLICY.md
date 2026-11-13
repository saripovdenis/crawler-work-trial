# Site policies

`config/sites.ts` holds one typed `SitePolicy` per configured domain:

```ts
{
  domain: 'hoodline.com', enabled: true, requestsPerMinute: 5,
  fetchProfile: 'chrome',
  discoverySources: [{ kind: 'feed', url: 'https://hoodline.com/rss' }],
}
```

Only `config/site-policy.ts` imports those defaults. Other modules use:

- `policy.for(domain)`: exact configured domain, or `undefined`.
- `policy.active()`: enabled domains, in file order (the existing claim tie-break).
- `policy.all()`: configured domains including paused ones, for history and parsing.

All 20 limits are unchanged. All domains are enabled by default. Subdomains share
their configured parent domain's budget and fetch profile. Every publisher HTTP
request goes through the Python curl_cffi worker, which also owns claims, archives,
durable receipts and mirror uploads. The existing service is replaced, not split.
`domainFor(url)` recognizes paused domains too; recognizing a URL never authorizes
a request. The scheduler and worker separately check `enabled` before dispatch.

## Validation

Importing the policy validates unique lowercase DNS names, no parent/child domain
overlaps, boolean enabled flags, known profile names, and integer limits from 1
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

This configuration cleanup changes no fetch headers, source URLs, budgets, parser
selectors or host scopes. It is not a throughput or coverage optimization. Parser
cache keys include the config and source files, so this release invalidates old
extraction caches; it does not refetch articles just to warm them.

## Discovery sources

`discoverySources` is an optional ordered list on each site. Supported kinds are
`html`, `feed` (RSS/Atom), `sitemap` (including indexes), and `api` with a named
adapter. For example:

```ts
{
  domain: 'sina.com.cn', enabled: true, requestsPerMinute: 30,
  articleAdapter: 'sina',
  discoverySources: [
    { kind: 'api', adapter: 'sina-roll', url: 'https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2509&num=50&page=1' },
    { kind: 'html', url: 'https://finance.sina.com.cn/roll/c/51894.shtml' },
  ],
}
```

The scheduler seeds these URLs into `sources`; sites with no configured sources
start at `https://www.<domain>/`. Unattempted configured sources take precedence
in array order, including over an existing article queue. Robots checks, request
limits, cooldowns and existing leases still apply. Sources already polled or
failed resume their stored schedule; restarting does not replay a bootstrap.
After the first attempts, normal source scoring and article/discovery turns apply.
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
| chosun.com | Main and business news sitemaps | Both already discover articles |
| antaranews.com | Latest RSS | Official RSS directory and successful DB source |
| bbc.com | News sitemap index | Existing seed; its child news maps discover articles |
| hoodline.com | RSS | Existing successful source; avoids www redirect |
| udn.com | Google News sitemap | Existing successful source |
| hurriyet.com.tr | Breaking-news HTML | Existing configured source |
| haberturk.com | General and local recent-news sitemaps | Existing successful sources |
| youm7.com | Homepage | Section RSS has repeated redirects/partial responses; not preferred |
| eastmoney.com | Important-news and domestic-economy HTML | Existing seeds; legacy gzip maps are stale |
| eldiario.es | Google News sitemap | Existing successful source |
| ce.cn | Homepage | Existing successful discovery; no better current feed verified |
| cnnbrasil.com.br | Admin-host news sitemap | Existing successful source |
| biobiochile.cl | RSS and news sitemap | Existing successful sources; freshness can differ |
| elmundo.es | All-news sitemap | Existing successful source; opaque name may change |
| mediapart.fr | Homepage + editor-choice news sitemap | Deliberately partial; section/archive maps remain discoverable |
| eleconomista.es | News sitemap | Existing successful source with browser headers |
| newindianexpress.com | News sitemap | Existing successful source |
| zaobao.com.sg | Realtime listing + homepage | Publisher's current listing; new seed needs live-run observation |

Publisher references: [ANTARA RSS](https://www.antaranews.com/rss/),
[ET RSS directory](https://economictimes.indiatimes.com/rss.cms),
[Zaobao realtime](https://www.zaobao.com.sg/realtime).

## Pausing

Set a domain's `enabled` to `false`, commit and deploy normally. Policies are
immutable for each process; this is a code switch, not a hot-reload or dashboard
write endpoint. Restart all services together so they use the same policy.

A pause prevents new crawler reservations and monitor provider polls for that
domain, including redirected requests into it. The worker refuses an old saved
assignment before sending. Existing charges remain charged; requests already sent
may finish. Completed archives can still be parsed.

Queued links and history remain. Stale-link cleanup excludes paused domains, and
expired/failed leases return their tasks to ready without increasing candidate
attempts while paused. On resuming, normal scheduling and age-based cleanup apply.
Unknown domains retained in the database are skipped; their pending archives wait
until a policy is restored. Prefer pausing to deleting a domain and its profiles.

The dashboard lists paused domains, shows a Paused badge, zero active allowance and
no eligibility timestamp. Historical request and article counts remain visible.

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
