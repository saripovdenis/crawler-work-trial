import { ProviderSelect } from "@/components/ProviderSelect";
import { comparisonProviders as names, selectedComparisonProvider } from "../../../../../config/comparison";
import { Sidebar } from "@/components/Sidebar";
import { SnapshotAge } from "@/components/SnapshotAge";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import "../App.css";
import "../charts/charts.css";
import "../reconciliation/reconciliation.css";
import "./freshness.css";
type Row = Record<string, any>;
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
    [provider, setProvider] = useState(selectedComparisonProvider(query.get("provider"))),
    [matches, setMatches] = useState(query.get("matches") || "all"),
    [page, setPage] = useState(Number(query.get("page")) || 1);
  const [data, setData] = useState<Row | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    const params = new URLSearchParams({ window, provider });
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
  }, [window, site, provider, matches, page]);
  const summary = data?.freshness?.overall;
  const percentiles = summary?.published;
  return (
    <div className="app-shell reconciliation-page freshness-page">
      <Sidebar active="freshness" />
      <main>
        <div className="reconcile-content">
          <div className="charts-heading">
            <h1>Freshness</h1>
            <p>How long after publication does your crawler finish downloading an article?</p>
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
                <option value="">All domains</option>
                {(data?.sites || []).map((s: string) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <ProviderSelect value={provider} onChange={value => { setProvider(value); setPage(1); }} />
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
          <section className="freshness-percentiles" aria-live="polite" aria-busy={loading}>
            <h2>Publication to fetch finish</h2>
            <dl>
              {["p50", "p75", "p90"].map((key) => (
                <div key={key}>
                  <dt>{key.toUpperCase()}</dt>
                  <dd>{duration(percentiles?.[key])}</dd>
                </div>
              ))}
            </dl>
            {["p50", "p75", "p90"].some((key) => percentiles?.[key] < 0) && (
              <p>A percentile is before reported publication; check the source timestamps.</p>
            )}
          </section>
          <div className="freshness-sample">
            <span><b>{number(summary?.total || 0)}</b> article records</span>
            <span><b>{number(percentiles?.count || 0)}</b> included in percentiles</span>
            <span><b>{number(summary?.unmatched || 0)}</b> without a matched fetch</span>
            <span><b>{number(summary?.missingTiming || 0)}</b> missing fetch timestamp</span>
          </div>
          {data?.truncated && (
            <p className="reconcile-definition">
              <b>The available sample is truncated by a provider or query limit.</b>
            </p>
          )}
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
                  <td>{!g.match ? "No matched fetch" : timing?.fetchFinishedAt == null ? "Fetch time unknown" : g.unparsed ? "Fetched · not parsed" : g.incomplete ? "Fetched · incomplete parse" : "Fetched"}{g.match === "title" && <small>Probable title match</small>}</td>
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
