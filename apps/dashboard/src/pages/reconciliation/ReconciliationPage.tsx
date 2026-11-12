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
  ExternalLink,
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
  const [window, setWindow] = useState(query.get("window") || "24h"),
    [site, setSite] = useState(query.get("site") || ""),
    [provider, setProvider] = useState(query.get("provider") || "");
  const [data, setData] = useState<Row | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const params = new URLSearchParams({ window });
    if (site) params.set("site", site);
    if (provider) params.set("provider", provider);
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
  }, [window, site, provider, refresh]);
  const summary = data?.summary;
  const missing = (data?.groups || []).filter((g: Row) => !g.match);
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
          <span>Provider polls every 30 min</span>
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
              Window
              <select
                value={window}
                onChange={(e) => setWindow(e.target.value)}
              >
                <option value="1h">Last hour</option>
                <option value="24h">Last 24 hours</option>
                <option value="7d">Last 7 days</option>
              </select>
            </label>
            <label>
              Domain
              <select value={site} onChange={(e) => setSite(e.target.value)}>
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
                onChange={(e) => setProvider(e.target.value)}
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
            </span>
          </div>
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
              <span>Matched coverage · provider sample</span>
              <strong>{percent(summary?.percentage)}</strong>
              <p>
                {summary
                  ? `${number(summary.matched)} of ${number(summary.total)} unique external articles in our database`
                  : "Collecting the first sample"}
              </p>
              <div className="coverage-track">
                <i style={{ width: (summary?.percentage || 0) + "%" }} />
              </div>
              <small>
                {summary
                  ? `${number(summary.urlMatched)} URL matches · ${number(summary.titleMatched)} probable title/date matches`
                  : "No percentage until providers return articles."}
              </small>
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
            uses our first observation at a provider. Exact URL matches are
            strongest; title + domain + publication time matches are probable.{" "}
            {data?.truncated && (
              <b>
                One or more result sets reached a provider limit: this is a
                truncated sample.
              </b>
            )}
          </p>
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
                  <p>{p?.note || "30-minute polls · staggered requests"}</p>
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
                    <th>Coverage</th>
                    <th>Matched / sample</th>
                    {Object.values(names).map((n) => (
                      <th key={n}>{n}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(data?.matrix || []).map((r: Row) => (
                    <tr key={r.site}>
                      <td>
                        <button onClick={() => setSite(r.site)}>
                          {r.site}
                        </button>
                      </td>
                      <td>
                        {percent(r.percentage)}
                        <div className="mini-track">
                          <i style={{ width: (r.percentage || 0) + "%" }} />
                        </div>
                      </td>
                      <td>
                        {r.total ? `${r.matched} / ${r.total}` : "No sample"}
                      </td>
                      {Object.keys(names).map((id) => (
                        <td key={id}>{r.counts[id] || "—"}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="reconcile-panel">
            <div className="panel-heading">
              <div>
                <h2>Articles to investigate</h2>
                <p>
                  Unmatched does not prove missed. Providers may return stale
                  stories, aliases, or different titles.
                </p>
              </div>
              <Badge variant="outline">{missing.length} shown · max 200</Badge>
            </div>
            <div className="reconcile-missing">
              {missing.length ? (
                missing.map((g: Row) => (
                  <article key={g.key}>
                    <div>
                      <a href={g.url} target="_blank" rel="noreferrer">
                        {g.title || g.url}
                        <ExternalLink size={12} />
                      </a>
                      <p>
                        {g.site} ·{" "}
                        {g.providers.map((p: string) => names[p]).join(", ")} ·
                        first observed {time(g.observed_at)}
                        {g.audit &&
                          ` · audit ${g.audit.status ? "HTTP " + g.audit.status : g.audit.state}`}
                      </p>
                    </div>
                    <Badge variant="outline">
                      {g.ambiguous
                        ? "Ambiguous title"
                        : g.observed_at > data!.generatedAt - 1800000
                          ? "Catching up"
                          : g.url_key
                            ? "Not matched"
                            : "URL unresolved"}
                    </Badge>
                  </article>
                ))
              ) : (
                <div className="reconcile-empty">
                  {summary?.total
                    ? "Every article in this sample currently has a match."
                    : "No provider sample yet. No coverage claim is made."}
                </div>
              )}
            </div>
          </section>
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
