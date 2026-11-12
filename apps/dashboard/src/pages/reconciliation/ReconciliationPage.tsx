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
    [loading, setLoading] = useState(true),
    [refresh, setRefresh] = useState(0);
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
  }, [window, site, provider, matches, page, refresh]);
  const summary = data?.summary;
  return (
    <div className="app-shell reconciliation-page">
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
            className="nav-item active"
            href="/reconciliation"
            aria-current="page"
          >
            <ScanSearch size={17} />
            Coverage
          </a>
          <a className="nav-item" href="/freshness"><Clock3 size={17} />Freshness</a>
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
            <strong>Coverage</strong>
          </div>
          <span>Provider polls every {data?.cadenceMinutes ?? 10} min</span>
        </header>
        <div className="reconcile-content">
          <div className="reconcile-heading">
            <div className="charts-heading">
              <span className="charts-eyebrow">RECONCILIATION</span>
              <h1>
                Coverage<span>.</span>
              </h1>
              <p>Compare crawler articles with external news indexes.</p>
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
              <span>Fetched coverage · provider sample</span>
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
              <span>Parsed coverage · provider sample</span>
              <strong>{percent(summary?.parsedPercentage)}</strong>
              <p>{summary ? `${number(summary.parsedMatched)} / ${number(summary.total)} external articles saved as parsed records` : "Waiting for data"}</p>
              <small>{summary ? `${number(summary.completeMatched)} complete (${percent(summary.completePercentage)}) · ${number(summary.incomplete)} incomplete · ${number(summary.unparsed)} fetched without a parsed record` : "Includes complete and incomplete parses."}</small>
            </section>
            <section>
              <span>Not matched</span>
              <strong>{summary ? number(summary.unmatched) : "—"}</strong>
              <p>
                External articles still absent after a 30-minute grace period.
              </p>
            </section>
            <section>
              <span>Catching up</span>
              <strong>{summary ? number(summary.waiting) : "—"}</strong>
              <p>New external sightings within the grace period.</p>
            </section>
          </div>
          <p className="reconcile-definition">
            This measures the provider sample, not the whole website. Window
            uses the publication date reported by each provider, in UTC. Both percentages
            use the same external sample: fetched means an archived successful article download;
            parsed means a saved article record, including incomplete parses. Exact URL
            matches are strongest; title + domain + publication time matches are probable.{" "}
            {data?.unknownPublication > 0 && `${number(data?.unknownPublication || 0)} sightings with unknown publication dates are excluded. `}
            {data && data.excludedNonArticles > 0 && `${number(data.excludedNonArticles)} verified topic/profile pages are excluded. `}
            {data?.truncated && (
              <b>
                One or more result sets reached a provider limit: this is a
                truncated sample.
              </b>
            )}
          </p>
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
              <div>
                <h2>Provider × domain</h2>
                <p>
                  Unique external articles per provider. The union is
                  deduplicated.
                </p>
              </div>
              <Badge variant="outline">20 configured sites</Badge>
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
