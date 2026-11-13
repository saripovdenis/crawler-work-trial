# Site policies

`config/sites.ts` holds one typed `SitePolicy` per configured domain:

```ts
{ domain: 'hoodline.com', enabled: true, requestsPerMinute: 5, transport: 'chrome136' }
```

Only `config/site-policy.ts` imports those defaults. Other modules use:

- `policy.for(domain)`: exact configured domain, or `undefined`.
- `policy.active()`: enabled domains, in file order (the existing claim tie-break).
- `policy.all()`: configured domains including paused ones, for history and parsing.

All 20 limits and the two Chrome transports are unchanged. All domains are enabled
by default. Subdomains share their configured parent domain's budget and transport.
`domainFor(url)` recognizes paused domains too; recognizing a URL never authorizes
a request. The scheduler and worker separately check `enabled` before dispatch.

## Validation

Importing the policy validates unique lowercase DNS names, no parent/child domain
overlaps, boolean enabled flags, supported transports, and integer limits from 1
through the global ceiling of 60 requests/minute. The scheduler imports it before
opening the database. Invalid policies fail startup.

Publication/body profiles, Arc hosts, discovery seeds and host priorities, Google
editions, title suffixes and non-article hosts/routes must reference configured
domains. Seed URLs must belong to their named domain. Regexes and extraction rules
remain reviewed code. The static boundary check rejects imports of raw defaults
outside the policy module.

## Discovery sources

`discoverySources` is an optional ordered list on each site. Supported kinds are
`html`, `feed` (RSS/Atom), `sitemap` (including indexes), and `api` with a named
adapter. For example:

```ts
{
  domain: 'sina.com.cn', enabled: true, requestsPerMinute: 30, transport: 'node',
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

`siteRules` names the existing 10-minute warm-up (60/min), 60-second rolling window,
20ms spacing margin and 35-second reserve for an unfinished request. The latter
covers 5s dispatch + 25s transport + 5s margin. The ledger remains authoritative.

The scheduler and dashboard use `budgetDue()` in `packages/core/src/policy.ts`,
including spacing after the previous request's finish (or conservative unfinished
reserve), rolling starts, and cooldown. The dashboard's **Budget eligible** column
is the earliest budget time, not a promise of dispatch: queued work, a live lease
and origin-specific robots rules can delay a request further.

No database schema, ports, processes or environment variables change. A future
table-backed policy store can implement the same accessor interface; policy history,
reloads and indexed next-eligible scheduling are intentionally deferred.
