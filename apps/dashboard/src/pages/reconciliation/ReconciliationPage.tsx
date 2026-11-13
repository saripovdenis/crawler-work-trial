import { Sidebar } from "@/components/Sidebar";
import { SnapshotAge } from "@/components/SnapshotAge";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import "../App.css";
import "../charts/charts.css";
import "./reconciliation.css";
type Row = Record<string, any>;
const names: Record<string, string> = {
  google: "Google News",
  exa: "Exa",
};
const number = (v: number) => new Intl.NumberFormat("en-US").format(v);
const time = (v: number | null) =>
  v ? new Date(v).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "—";
const percent = (v: number | null | undefined) =>
  v == null ? "—" : v.toFixed(1) + "%";
export default function ReconciliationPage() {
  const query = new URLSearchParams(location.search);
  const [window, setWindow] = useState(query.get("window") || "1h"),
    [site, setSite] = useState(query.get("site") || ""),
    [provider, setProvider] = useState(query.get("provider") || ""),
    [matches] = useState(query.get("matches") || "all"),
    [page, setPage] = useState(Number(query.get("page")) || 1);
  const [data, setData] = useState<Row | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    const params = new URLSearchParams({ window });
    if (site) params.set("site", site);
    if (provider) params.set("provider", provider);
    if (matches !== "all") params.set("matches", matches);
    if (page > 1) params.set("page", String(page));
    history.replaceState(null, "", "/reconciliation?" + params);
    const controller = new AbortController();
    let running = false;
    async function load() {
      if (document.hidden || running) return;
      running = true;
      setLoading(true);
      try {
        const r = await fetch("/api/reconciliation?" + params, {
          signal: controller.signal,
        });
        if (!r.ok) throw new Error("Could not load reconciliation data.");
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
  const summary = data?.summary;
  return (
    <div className="app-shell reconciliation-page">
      <Sidebar active="coverage" />
      <main>
        <div className="reconcile-content">
          <div className="charts-heading">
            <h1>Coverage</h1>
            <p>Compare crawler articles with external news indexes.</p>
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
            <label>
              Provider
              <select
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">All providers</option>
                {Object.entries(names).map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <span className="reconcile-updated">
              Updated {time(data?.generatedAt || null)}
              <SnapshotAge generatedAt={data?.generatedAt} cache={data?.cache} />
            </span>
          </div>
          {window === "10m" && (
            <div className="reconcile-notice" role="status">
              Provisional: provider polls run every {data?.cadenceMinutes ?? 10} minutes.
              Indexing delays and later polls can change this sample.
            </div>
          )}
          {error && (
            <div className="reconcile-notice" role="alert">
              {error} Showing the last available result.
            </div>
          )}
          {!data?.ready && !loading && (
            <div className="reconcile-notice">
              Waiting for the reconciler’s first provider poll.
            </div>
          )}
          {data?.heartbeat && Date.now() - data.heartbeat > 90000 && (
            <div className="reconcile-notice" role="status">
              Reconciler heartbeat is stale. These results may be out of date.
            </div>
          )}
          <div className="reconcile-stats">
            <section className="coverage-hero">
              <span>Fetched coverage</span>
              <strong>{percent(summary?.fetchedPercentage)}</strong>
              <p>
                {summary
                  ? `${number(summary.fetchedMatched)} / ${number(summary.total)} external articles successfully downloaded`
                  : "Collecting the first sample"}
              </p>
              <div className="coverage-track">
                <i style={{ width: (summary?.fetchedPercentage || 0) + "%" }} />
              </div>
              <small>
                {summary
                  ? `${number(summary.urlMatched)} URL matches · ${number(summary.titleMatched)} probable title/date matches`
                  : "No percentage until providers return articles."}
              </small>
            </section>
            <section>
              <span>Parsed coverage</span>
              <strong>{percent(summary?.parsedPercentage)}</strong>
              <p>{summary ? `${number(summary.parsedMatched)} / ${number(summary.total)} external articles saved as parsed records` : "Waiting for data"}</p>
              <small>{summary ? `${number(summary.completeMatched)} complete (${percent(summary.completePercentage)}) · ${number(summary.incomplete)} incomplete · ${number(summary.unparsed)} fetched without a parsed record` : "Includes complete and incomplete parses."}</small>
            </section>
            <section>
              <span>Not matched · seen over 30 min ago</span>
              <strong>{summary ? number(summary.unmatched) : "—"}</strong>
            </section>
            <section>
              <span>Catching up · seen under 30 min ago</span>
              <strong>{summary ? number(summary.waiting) : "—"}</strong>
            </section>
          </div>
          {data && (data.unknownPublication > 0 || data.excludedNonArticles > 0 || data.truncated) && (
            <p className="reconcile-definition">
              {data.unknownPublication > 0 && `Excluded: ${number(data.unknownPublication)} with unknown publication date. `}
              {data.excludedNonArticles > 0 && `Excluded: ${number(data.excludedNonArticles)} verified non-article pages. `}
              {data.truncated && (
                <b>
                  One or more result sets reached a provider limit: this is a
                  truncated sample.
                </b>
              )}
            </p>
          )}
          {data && data.excludedNonArticles > 0 && (
            <details className="reconcile-definition">
              <summary>Review excluded pages ({data.excludedNonArticles}) · unfiltered coverage {percent(data.unfilteredSummary?.percentage)}</summary>
              <ul>{data.excludedGroups.map((g: Row) => <li key={g.url}><a href={g.url} target="_blank" rel="noreferrer">{g.title || g.url}</a> · {g.reason.replaceAll('_',' ')}</li>)}</ul>
            </details>
          )}
          {summary && !provider && (
            <p className="reconcile-definition">
              <strong>Combined sample: {number(summary.total)} unique articles.</strong>{" "}
              {number(summary.googleOnly)} Google News only + {number(summary.exaOnly)} Exa only + {number(summary.shared)} found by both.
              Different indexes, rankings and result limits produce different samples. Shared articles count once.
            </p>
          )}
          <div className="provider-grid">
            {Object.entries(names).map(([id, name]) => {
              const p = (data?.providers || []).find(
                (r: Row) => r.provider === id,
              );
              return (
                <section key={id}>
                  <header>
                    <strong>{name}</strong>
                    <Badge variant="outline">
                      {p?.quota_exhausted
                        ? "Quota reached"
                        : p?.enabled
                          ? "Scheduled"
                          : p?.note === "API key required"
                            ? "Needs key"
                            : p
                              ? "Paused"
                              : "Waiting"}
                    </Badge>
                  </header>
                  <p>
                    {p?.note ||
                      `${data?.cadenceMinutes ?? 10}-minute polls · staggered requests`}
                  </p>
                  <small>
                    {number(p?.used_today || 0)} calls / 24h
                    {p?.total_limit > 0
                      ? ` · ${number(p.used_total || 0)} / ${number(p.total_limit)} total cap`
                      : ""}
                  </small>
                  <small>Last success {time(p?.last_success)}</small>
                  {!!p?.enabled && !p.quota_exhausted && (
                    <small>Next due {time(p.next_poll)}</small>
                  )}
                  {p?.last_error && (
                    <small className="provider-error">{p.last_error}</small>
                  )}
                </section>
              );
            })}
          </div>
          <section className="reconcile-panel">
            <div className="panel-heading">
              <h2>Provider × domain</h2>
            </div>
            <div className="reconcile-table">
              <table>
                <thead>
                  <tr>
                    <th>Domain</th>
                    <th>Fetched / sample</th>
                    <th>Parsed / sample</th>
                    <th>Complete / sample</th>
                    {Object.values(names).map((n) => (
                      <th key={n}>{n}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(data?.matrix || []).map((r: Row) => (
                    <tr key={r.site}>
                      <td>
                        <button
                          onClick={() => {
                            setSite(r.site);
                            setPage(1);
                          }}
                        >
                          {r.site}
                        </button>
                      </td>
                      <td>
                        {percent(r.fetchedPercentage)}
                        <div>{r.total ? `${r.fetchedMatched} / ${r.total}` : "No sample"}</div>
                        <div className="mini-track">
                          <i style={{ width: (r.fetchedPercentage || 0) + "%" }} />
                        </div>
                      </td>
                      <td>
                        {percent(r.parsedPercentage)}
                        <div>{r.total ? `${r.parsedMatched} / ${r.total}` : "No sample"}</div>
                      </td>
                      <td>{percent(r.completePercentage)}<div>{r.total ? `${r.completeMatched} / ${r.total}` : "No sample"}</div></td>
                      {Object.keys(names).map((id) => (
                        <td key={id}>{r.counts[id] || "—"}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          {data?.dispatch?.available && (
            <section className="reconcile-panel">
              <div className="panel-heading"><div><h2>Dispatch · last hour</h2><p>Assignment to reported worker start; includes the selected domain.</p></div></div>
              <p className="timing-note">{number(data.dispatch.attempts)} assignments · p50 {data.dispatch.p50Ms ?? "—"} ms · p95 {data.dispatch.p95Ms ?? "—"} ms · max {data.dispatch.maxMs ?? "—"} ms<br />
                {number(data.dispatch.deadlineFailures)} internal deadline failures · {number(data.dispatch.unsent)} completed without a reported start · {number(data.dispatch.leaseExpiries)} expired leases.
                {data.dispatch.byTransport.map((t: Row) => ` ${t.transport}: ${t.deadlineFailures} deadline failures / ${t.attempts} assignments.`).join("")}
              </p>
            </section>
          )}
          <p className="reconcile-definition">
            <a href={`/freshness?${new URLSearchParams({ window, site, provider })}#article-timing`}>Inspect per-article timing on Freshness →</a>
          </p>
          <section className="reconcile-panel">
            <div className="panel-heading">
              <div>
                <h2>Recent provider calls</h2>
                <p>
                  Refreshing this page reads stored results; it does not spend
                  provider quota.
                </p>
              </div>
            </div>
            <div className="reconcile-table">
              <table>
                <thead>
                  <tr>
                    <th>Started UTC</th>
                    <th>Provider</th>
                    <th>Domain</th>
                    <th>Result</th>
                    <th>Accepted / returned</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.runs || []).slice(0, 30).map((r: Row) => (
                    <tr key={r.id}>
                      <td>{time(r.started_at)}</td>
                      <td>{names[r.provider]}</td>
                      <td>{r.site}</td>
                      <td>
                        <Badge variant="outline">{r.status}</Badge>
                      </td>
                      <td>
                        {r.accepted_count} / {r.result_count}
                      </td>
                      <td>
                        {r.error || (r.truncated ? "Result cap reached" : "—")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
