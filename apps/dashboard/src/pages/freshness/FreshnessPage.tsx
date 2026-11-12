import { useEffect, useState } from "react";
import {
  Activity,
  BarChart3,
  ChevronRight,
  Clock3,
  FileText,
  Globe2,
  LayoutDashboard,
  ScanSearch,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import "../App.css";
import "../charts/charts.css";
import "../reconciliation/reconciliation.css";
import "./freshness.css";
import TimingComparison from "./TimingComparison";
import ArticleTiming from "../reconciliation/ArticleTiming";
import { Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
type Row = Record<string, any>;
const names: Record<string, string> = {
  google: "Google News",
  exa: "Exa",
};
const number = (v: number) => new Intl.NumberFormat("en-US").format(v);
const time = (v: number | null) =>
  v ? new Date(v).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "—";
const duration = (v: number | null | undefined) => {
  if (v == null) return "—";
  const seconds = Math.abs(v) / 1000;
  const label = seconds < 60 ? `${Math.round(seconds)}s` : seconds < 3600 ? `${(seconds / 60).toFixed(1)}m` : `${(seconds / 3600).toFixed(1)}h`;
  return `${v < 0 ? "−" : v > 0 ? "+" : ""}${label}`;
};
export default function FreshnessPage() {
  const query = new URLSearchParams(location.search);
  const [window, setWindow] = useState(query.get("window") || "1h"),
    [site, setSite] = useState(query.get("site") || ""),
    [provider, setProvider] = useState(query.get("provider") || ""),
    [matches, setMatches] = useState(query.get("matches") || "all"),
    [page, setPage] = useState(Number(query.get("page")) || 1);
  const [baseline, setBaseline] = useState(query.get("baseline") === "observed" ? "observed" : "published");
  const [data, setData] = useState<Row | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const params = new URLSearchParams({ window });
    if (site) params.set("site", site);
    if (provider) params.set("provider", provider);
    if (matches !== "all") params.set("matches", matches);
    if (page > 1) params.set("page", String(page));
    params.set("baseline", baseline);
    history.replaceState(null, "", "/freshness?" + params);
    const controller = new AbortController();
    let running = false;
    async function load() {
      if (document.hidden || running) return;
      running = true;
      setLoading(true);
      try {
        const r = await fetch("/api/freshness?" + params, {
          signal: controller.signal,
        });
        if (!r.ok) throw new Error("Could not load freshness data.");
        setData(await r.json());
        setError("");
      } catch (e) {
        if (!controller.signal.aborted) setError(String(e));
      } finally {
        running = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    const timer = setInterval(() => void load(), 30000);
    document.addEventListener("visibilitychange", load);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [window, site, provider, matches, page, refresh, baseline]);
  const displayDuration = (value: number | null | undefined) => baseline === "published" ? duration(value).replace(/^\+/, "") : duration(value);
  const freshness = data?.freshness;
  const summary = freshness?.overall;
  const percentiles = summary?.[baseline];
  const chartData = (freshness?.providers || []).map((p: Row) => ({
    provider: names[p.provider], p50: p[baseline].p50, p75: p[baseline].p75, p90: p[baseline].p90,
  }));
  return (
    <div className="app-shell reconciliation-page freshness-page">
      <aside className="sidebar">
        <a className="wordmark" href="/">
          exa<span className="wordmark-dot">*</span>
          <span className="brand-divider" />
          <span className="brand-project">
            crawler
            <br />
            observatory
          </span>
        </a>
        <div className="workspace">
          <span className="workspace-icon">
            <Globe2 size={17} />
          </span>
          <div>
            News discovery<span>External comparison</span>
          </div>
          <ChevronRight size={14} />
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav aria-label="Dashboard">
          <a className="nav-item" href="/?view=overview">
            <LayoutDashboard size={17} />
            Overview
          </a>
          <a className="nav-item" href="/?view=requests">
            <Activity size={17} />
            Request log
          </a>
          <a className="nav-item" href="/?view=articles">
            <FileText size={17} />
            Articles
          </a>
          <a className="nav-item" href="/?view=schedule">
            <Clock3 size={17} />
            Poll schedule
          </a>
          <a className="nav-item" href="/charts">
            <BarChart3 size={17} />
            Charts
          </a>
          <a
            className="nav-item"
            href="/reconciliation"
          >
            <ScanSearch size={17} />
            Coverage
          </a>
          <a className="nav-item active" href="/freshness" aria-current="page"><Clock3 size={17} />Freshness</a>
        </nav>
        <div className="sidebar-note">
          <ScanSearch size={18} />
          <strong>An independent cross-check.</strong>
          <p>External finds stay separate from crawler discoveries.</p>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div className="breadcrumb">
            <a href="/">Workspace</a>
            <ChevronRight size={13} />
            <strong>Freshness</strong>
          </div>
          <span>Provider polls every {data?.cadenceMinutes ?? 10} min</span>
        </header>
        <div className="reconcile-content">
          <div className="reconcile-heading">
            <div className="charts-heading">
              <span className="charts-eyebrow">RECONCILIATION</span>
              <h1>
                Freshness<span>.</span>
              </h1>
              <p>Compare your crawler’s download with Google News and Exa observations, starting at publication.</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRefresh((x) => x + 1)}
              disabled={loading}
            >
              <RefreshCw size={14} />
              {loading ? "Loading…" : "Refresh view"}
            </Button>
          </div>
          <div className="reconcile-filters">
            <label>
              Published within
              <select
                value={window}
                onChange={(e) => {
                  setWindow(e.target.value);
                  setPage(1);
                }}
              >
                <option value="10m">Last 10 minutes</option>
                <option value="1h">Last hour</option>
                <option value="24h">Last 24 hours</option>
                <option value="7d">Last 7 days</option>
              </select>
            </label>
            <label>
              Domain
              <select
                value={site}
                onChange={(e) => {
                  setSite(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">All 20 domains</option>
                {(data?.sites || []).map((s: string) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <label>
              Compare with
              <select
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">Google News + Exa</option>
                {Object.entries(names).map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <span className="reconcile-updated">
              Updated {time(data?.generatedAt || null)}
            </span>
          </div>
          {error && (
            <div className="reconcile-notice" role="alert">
              {error}{data ? " Showing the last available result." : " Try refreshing."}
            </div>
          )}
          {loading && !data && <div className="reconcile-notice" role="status">Loading freshness…</div>}
          {!data?.ready && !loading && !error && (
            <div className="reconcile-notice">
              Waiting for the reconciler’s first provider poll.
            </div>
          )}
          {data?.heartbeat && Date.now() - data.heartbeat > 90000 && (
            <div className="reconcile-notice" role="status">
              Reconciler heartbeat is stale. These results may be out of date.
            </div>
          )}
          <TimingComparison data={freshness?.comparison} loading={loading} cadence={data?.cadenceMinutes ?? 10} />
          <details className="freshness-advanced">
            <summary>More diagnostics: our crawler across all matched articles</summary>
            <div className="reconcile-filters">
            <label>
              Timing view
              <select value={baseline} onChange={e => setBaseline(e.target.value)}>
                <option value="published">Publication → our download</option>
                <option value="observed">Our download vs our provider poll</option>
              </select>
            </label>
            </div>
          <div className="reconcile-stats freshness-stats" aria-live="polite" aria-busy={loading}>
            {[["p50", "Half of timed articles"], ["p75", "75% of timed articles"], ["p90", "90% of timed articles"]].map(([key, description]) => (
              <section key={key} className={key === "p50" ? "coverage-hero" : ""}>
                <span>{key.toUpperCase()} · {baseline === "published" ? "publication-to-download delay" : "offset from our provider poll"}</span>
                <strong>{displayDuration(percentiles?.[key])}</strong>
                <p>{baseline === "published"
                  ? percentiles?.[key] < 0 ? "Before the reported publication time; check the source timestamps." : `${description} were downloaded within this time after publication.`
                  : "Negative: downloaded before our poll saw it. Positive: downloaded after."}</p>
                <small>{number(percentiles?.count || 0)} unique timed articles</small>
              </section>
            ))}
          </div>
          <p className="reconcile-definition">
            {baseline === "published" ? <>
              Delay = our download finish − the article’s reported publication time. For example: published at 12:00, downloaded at 12:02 → 2 minutes.
              Publication dates come from Google News or Exa; they are not the time those services indexed the article.
            </> : <>
              This compares our download with when our own poll first found the article in provider results.
              It does not measure whether we beat Google News or Exa: their indexing time is unknown.
              We poll every {data?.cadenceMinutes ?? 10} minutes; outages and quota limits can delay observation further.
            </>}
            {" "}The combined sample counts each article once, using its earliest selected-provider timestamp. Window: reported publication, UTC.
          </p>
          <div className="freshness-sample" aria-live="polite">
            <span><b>{number(summary?.total || 0)}</b> sampled</span>
            <span><b>{number(summary?.timed || 0)}</b> timed matches</span>
            <span><b>{number(summary?.unmatched || 0)}</b> not matched</span>
            <span><b>{number(summary?.missingTiming || 0)}</b> matched, no fetch time</span>
            <span><b>{number(summary?.incomplete || 0)}</b> timed but incomplete</span>
            <span><b>{number(summary?.probable || 0)}</b> timed probable title matches</span>
          </div>
          <p className="reconcile-definition">
            These delays cover matched articles in the external sample, including incomplete parses—not every article on each website. Unmatched articles and unknown fetch times are excluded from percentiles;
            they are not zero-delay successes. Compare with <a href={`/reconciliation?${new URLSearchParams({ window, site, provider })}`}>coverage</a> to assess missed articles.
            {data?.unknownPublication > 0 && ` ${number(data?.unknownPublication || 0)} sightings have no publication date and are outside this window.`}
            {data?.excludedNonArticles > 0 && ` ${number(data?.excludedNonArticles || 0)} known non-article pages excluded, as on Coverage.`}
            {data?.truncated && <b> A provider or query limit truncated this sample.</b>}
          </p>
          <section className="reconcile-panel">
            <div className="panel-heading"><div><h2>Our download timing by article sample</h2><p>Both bars measure our crawler. Google News and Exa supply different article samples, not competing download times.</p></div><Badge variant="outline">P50 / P75 / P90</Badge></div>
            <div className="freshness-chart">
              {percentiles?.count ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} margin={{ top: 16, right: 20, bottom: 8, left: 4 }} accessibilityLayer>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#edf0f6" />
                    <XAxis dataKey="provider" tickLine={false} axisLine={false} tick={{ fontSize: 11 }} />
                    <YAxis tickFormatter={displayDuration} tickLine={false} axisLine={false} width={64} tick={{ fontSize: 10 }} />
                    <ReferenceLine y={0} stroke="#8991a3" />
                    <Tooltip formatter={(value, name) => [displayDuration(Number(value)), String(name).toUpperCase()]} />
                    <Bar dataKey="p50" fill="#1840ed" radius={[3, 3, 0, 0]} isAnimationActive={false} />
                    <Bar dataKey="p75" fill="#768df5" radius={[3, 3, 0, 0]} isAnimationActive={false} />
                    <Bar dataKey="p90" fill="#bac7fa" radius={[3, 3, 0, 0]} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              ) : <div className="reconcile-empty">{loading ? "Loading timing samples…" : "No matched articles with a known fetch time in this window."}</div>}
            </div>
            <div className="reconcile-table"><table>
              <caption className="sr-only">Our crawler timing by provider article sample, also shown in the chart</caption>
              <thead><tr><th>Article sample</th><th>Timed / sample</th><th>P50</th><th>P75</th><th>P90</th><th>Not matched</th></tr></thead>
              <tbody>{(freshness?.providers || []).map((p: Row) => <tr key={p.provider}>
                <td>{names[p.provider]}</td><td>{p[baseline].count} / {p.total}</td>
                <td>{displayDuration(p[baseline].p50)}</td><td>{displayDuration(p[baseline].p75)}</td><td>{displayDuration(p[baseline].p90)}</td><td>{p.unmatched}</td>
              </tr>)}</tbody>
            </table></div>
          </section>
          <section className="reconcile-panel">
            <div className="panel-heading"><div><h2>Our download timing by domain</h2><p>Domains without timing samples show “—”. Select a domain to inspect its articles.</p></div></div>
            <div className="reconcile-table"><table>
              <thead><tr><th>Domain</th><th>Timed / sample</th><th>P50</th><th>P75</th><th>P90</th><th>Not matched</th><th>No fetch time</th></tr></thead>
              <tbody>{(freshness?.domains || []).map((d: Row) => <tr key={d.site}>
                <td><button onClick={() => { setSite(d.site); setPage(1); }}>{d.site}</button></td><td>{d[baseline].count} / {d.total}</td>
                <td>{displayDuration(d[baseline].p50)}</td><td>{displayDuration(d[baseline].p75)}</td><td>{displayDuration(d[baseline].p90)}</td><td>{d.unmatched}</td><td>{d.missingTiming}</td>
              </tr>)}</tbody>
            </table></div>
          </section>
          </details>
          <ArticleTiming data={data} matches={matches} setMatches={setMatches} page={page} setPage={setPage} loading={loading} />
        </div>
      </main>
    </div>
  );
}
