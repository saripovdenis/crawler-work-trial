import { SnapshotAge } from "@/components/SnapshotAge";
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
import "../App.css";
import "../charts/charts.css";
import "../reconciliation/reconciliation.css";
import "./freshness.css";
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
  return `${v < 0 ? "−" : ""}${label}`;
};
export default function FreshnessPage() {
  const query = new URLSearchParams(location.search);
  const [window, setWindow] = useState(query.get("window") || "1h"),
    [site, setSite] = useState(query.get("site") || ""),
    [matches, setMatches] = useState(query.get("matches") || "all"),
    [page, setPage] = useState(Number(query.get("page")) || 1);
  const [data, setData] = useState<Row | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const params = new URLSearchParams({ window });
    if (site) params.set("site", site);
    if (matches !== "all") params.set("matches", matches);
    if (page > 1) params.set("page", String(page));
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
  }, [window, site, matches, page, refresh]);
  const summary = data?.freshness?.overall;
  const percentiles = summary?.published;
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
          <strong>Publication → completed download.</strong>
          <p>One delay per article, from its earliest reported publication date.</p>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div className="breadcrumb">
            <a href="/">Workspace</a>
            <ChevronRight size={13} />
            <strong>Freshness</strong>
          </div>
          <span>All timestamps in UTC</span>
        </header>
        <div className="reconcile-content">
          <div className="reconcile-heading">
            <div className="charts-heading">
              <span className="charts-eyebrow">RECONCILIATION</span>
              <h1>
                Freshness<span>.</span>
              </h1>
              <p>How long after publication does your crawler finish downloading an article?</p>
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
            <span className="reconcile-updated">
              Updated {time(data?.generatedAt || null)}
              <SnapshotAge generatedAt={data?.generatedAt} cache={data?.cache} />
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
          <div className="reconcile-stats freshness-stats" aria-live="polite" aria-busy={loading}>
            {[["p50", "50%"], ["p75", "75%"], ["p90", "90%"]].map(([key, fraction]) => (
              <section key={key} className={key === "p50" ? "coverage-hero" : ""}>
                <span>{key.toUpperCase()} · publication to fetch finish</span>
                <strong>{duration(percentiles?.[key])}</strong>
                <p>{percentiles?.[key] < 0 ? "Before reported publication; check the source timestamps." : `${fraction} of timed articles finished within this delay.`}</p>
                <small>{number(percentiles?.count || 0)} timed articles</small>
              </section>
            ))}
          </div>
          <p className="reconcile-definition">
            <strong>Delay = fetch finish − earliest publication date from Google News or Exa.</strong>{" "}
            One provider’s date is enough; when both have a date, we use the earlier one.
            Example: published at 12:00, downloaded at 12:02 → 2 minutes.
          </p>
          <div className="freshness-sample">
            <span><b>{number(summary?.total || 0)}</b> article records</span>
            <span><b>{number(percentiles?.count || 0)}</b> included in percentiles</span>
            <span><b>{number(summary?.unmatched || 0)}</b> without a matched fetch</span>
            <span><b>{number(summary?.missingTiming || 0)}</b> missing fetch timestamp</span>
          </div>
          <p className="reconcile-definition">
            Percentiles use all timed articles in this window, including incomplete parses—not just this table page.
            Unmatched articles and unknown timestamps are excluded, never counted as zero. This covers articles found by Google News or Exa, not every article on the web.
            {data?.truncated && <strong> The available sample is truncated by a provider or query limit.</strong>}
          </p>
          <section className="reconcile-panel">
            <div className="panel-heading"><div><h2>Article records</h2><p>Earliest publication, your fetch finish and the delay for each URL. All times UTC.</p></div>
              <label className="timing-filter">Show
                <select value={matches} onChange={e => { setMatches(e.target.value); setPage(1); }}>
                  <option value="all">All records</option><option value="matched">Fetched</option><option value="unmatched">No matched fetch</option>
                </select>
              </label>
            </div>
            <div className="reconcile-table fetch-delay-table"><table>
              <thead><tr><th>Article / URL</th><th>Earliest publication UTC</th><th>Fetch finished UTC</th><th>Delay</th><th>Status</th></tr></thead>
              <tbody>{(data?.groups || []).map((g: Row) => {
                const timing = g.publication_timing;
                const url = g.article_url || g.url;
                return <tr key={g.key}>
                  <td className="fetch-delay-article"><a href={url} target="_blank" rel="noreferrer">{g.title || url}</a><small className="fetch-delay-url" title={url}>{url}</small><small>{g.site}</small></td>
                  <td>{time(timing?.publishedAt)}<small>{(timing?.providers || []).map((id: string) => names[id] || id).join(" + ")}</small></td>
                  <td>{time(timing?.fetchFinishedAt)}{g.crawler_request_id && <small><a href={`/api/requests/${g.crawler_request_id}`} target="_blank" rel="noreferrer">Fetch #{g.crawler_request_id}</a></small>}</td>
                  <td><strong>{duration(timing?.delayMs)}</strong>{timing?.delayMs < 0 && <small>Check timestamps</small>}</td>
                  <td>{!g.match ? "No matched fetch" : timing?.fetchFinishedAt == null ? "Fetch time unknown" : g.incomplete ? "Fetched · incomplete parse" : "Fetched"}{g.match === "title" && <small>Probable title match</small>}</td>
                </tr>;
              })}</tbody>
            </table></div>
            {!data?.groups?.length && <div className="reconcile-empty">{loading ? "Loading article records…" : "No article records match these filters."}</div>}
            <div className="timing-pagination">
              <span>{number(data?.groupCount || 0)} records · Page {page} of {Math.max(1, data?.pageCount || 0)}</span>
              <Button variant="outline" size="sm" disabled={loading || page <= 1} onClick={() => setPage(p => p - 1)}>Previous</Button>
              <Button variant="outline" size="sm" disabled={loading || page >= (data?.pageCount || 0)} onClick={() => setPage(p => p + 1)}>Next</Button>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
