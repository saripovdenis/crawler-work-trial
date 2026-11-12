import { useEffect, useState } from "react";
import { Activity, BarChart3, ChevronRight, Clock3, FileText, Globe2, LayoutDashboard, RefreshCw, ScanSearch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SnapshotAge } from "@/components/SnapshotAge";
import "../App.css";
import "../charts/charts.css";
import "../reconciliation/reconciliation.css";
import "./crawler-only.css";

type Row = Record<string, any>;
const labels: Record<string, string> = {
  listed: "Listed", pending: "May still be listed", possible: "Possible match",
  strong: "Crawler-only · strong", weak: "Crawler-only · weak", not_comparable: "Not comparable",
};
const number = (value: number | undefined) => new Intl.NumberFormat("en-US").format(value || 0);
const time = (value: number | null | undefined) => value != null && Number.isFinite(value)
  ? new Date(value).toISOString().replace("T", " ").slice(0, 19) : "—";
const safeUrl = (value: string) => /^https?:\/\//i.test(value) ? value : "#";

function ProviderStatus({ evidence, provider }: { evidence?: Row; provider: string }) {
  if (!evidence) return <span className="crawler-status" data-status="not_comparable">Not compared</span>;
  const noPoll = evidence.status === "not_comparable" && /No successful .* poll/i.test(evidence.reason || "");
  const label = noPoll ? `No ${provider === "google" ? "Google" : "Exa"} poll` : labels[evidence.status] || "Not comparable";
  return <div className="crawler-evidence" title={evidence.reason || label}>
    <span className="crawler-status" data-status={evidence.status}>{label}</span>
    {evidence.match && <small>{evidence.match === "url" ? "URL match" : "Title + publication-time match"}</small>}
    {evidence.poll && <small title={`Last successful covering poll: ${time(evidence.poll.startedAt)} UTC`}>
      Last covering poll: {evidence.poll.truncated ? "capped" : "under cap"}
    </small>}
    {evidence.status === "not_comparable" && !noPoll && <small>{evidence.reason}</small>}
  </div>;
}

function PollCap({ value, provider }: { value?: Row; provider: string }) {
  if (!value?.successful) return <span className="crawler-no-poll">No {provider === "google" ? "Google" : "Exa"} poll
    {!!value?.failed && <small>{number(value.failed)} failed polls</small>}
  </span>;
  return <span>{Number(value.percentage || 0).toFixed(0)}%<small>{number(value.capped)} / {number(value.successful)} capped</small></span>;
}

export default function CrawlerOnlyPage() {
  const query = new URLSearchParams(location.search);
  const [window, setWindow] = useState(query.get("window") || "24h");
  const [site, setSite] = useState(query.get("site") || "");
  const [provider, setProvider] = useState(query.get("provider") || "both");
  const [show, setShow] = useState(query.get("show") || "all");
  const [page, setPage] = useState(Math.max(1, Number(query.get("page")) || 1));
  const [data, setData] = useState<Row | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const params = new URLSearchParams({ window });
    if (site) params.set("site", site);
    if (provider !== "both") params.set("provider", provider);
    if (show !== "all") params.set("show", show);
    if (page > 1) params.set("page", String(page));
    history.replaceState(null, "", "/crawler-only?" + params);
    const controller = new AbortController();
    let running = false;
    async function load() {
      if (document.hidden || running) return;
      running = true; setLoading(true);
      try {
        const response = await fetch("/api/crawler-only?" + params, { signal: controller.signal });
        if (!response.ok) throw new Error("Could not load crawler-only data.");
        const value = await response.json();
        if (!controller.signal.aborted) { setData(value); setError(""); }
      } catch (failure) {
        if (!controller.signal.aborted) setError(String(failure));
      } finally {
        running = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    const timer = setInterval(() => void load(), 30000);
    document.addEventListener("visibilitychange", load);
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", load); };
  }, [window, site, provider, show, page, refresh]);
  const summary = data?.summary;
  const limited = !!data?.rowsTruncated || (data?.rowCount ?? 0) < (data?.groupCount ?? 0);
  return <div className="app-shell reconciliation-page crawler-only-page">
    <aside className="sidebar">
      <a className="wordmark" href="/">exa<span className="wordmark-dot">*</span><span className="brand-divider" /><span className="brand-project">crawler<br />observatory</span></a>
      <div className="workspace"><span className="workspace-icon"><Globe2 size={17} /></span><div>News discovery<span>External comparison</span></div><ChevronRight size={14} /></div>
      <div className="nav-label">WORKSPACE</div>
      <nav aria-label="Dashboard">
        <a className="nav-item" href="/?view=overview"><LayoutDashboard size={17} />Overview</a>
        <a className="nav-item" href="/?view=requests"><Activity size={17} />Request log</a>
        <a className="nav-item" href="/?view=articles"><FileText size={17} />Articles</a>
        <a className="nav-item" href="/?view=schedule"><Clock3 size={17} />Poll schedule</a>
        <a className="nav-item" href="/charts"><BarChart3 size={17} />Charts</a>
        <a className="nav-item" href="/reconciliation"><ScanSearch size={17} />Coverage</a>
        <a className="nav-item" href="/freshness"><Clock3 size={17} />Freshness</a>
        <a className="nav-item active" href="/crawler-only" aria-current="page"><FileText size={17} />Crawler-only</a>
      </nav>
      <div className="sidebar-note"><ScanSearch size={18} /><strong>Compare both directions.</strong><p>Our parsed articles against saved provider samples.</p></div>
    </aside>
    <main>
      <header className="topbar"><div className="breadcrumb"><a href="/">Workspace</a><ChevronRight size={13} /><strong>Crawler-only</strong></div><span>All timestamps in UTC</span></header>
      <div className="reconcile-content">
        <div className="reconcile-heading">
          <div className="charts-heading"><span className="charts-eyebrow">RECONCILIATION</span><h1>Crawler-only<span>.</span></h1><p>Which articles did we fetch that saved provider samples do not list?</p></div>
          <Button variant="outline" size="sm" disabled={loading} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={14} />{loading ? "Loading…" : "Refresh view"}</Button>
        </div>
        <div className="reconcile-filters">
          <label>Published within<select value={window} onChange={e => { setWindow(e.target.value); setPage(1); }}><option value="1h">Last hour</option><option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option></select></label>
          <label>Domain<select value={site} onChange={e => { setSite(e.target.value); setPage(1); }}><option value="">All 20 domains</option>{(data?.sites || []).map((domain: string) => <option key={domain}>{domain}</option>)}</select></label>
          <label>Compare with<select value={provider} onChange={e => { setProvider(e.target.value); setPage(1); }}><option value="both">Google News + Exa</option><option value="google">Google News</option><option value="exa">Exa</option></select></label>
          <label>Status<select value={show} onChange={e => { setShow(e.target.value); setPage(1); }}><option value="all">All records</option><option value="crawler_only">Crawler-only · all evidence</option><option value="strong">Crawler-only · strong</option><option value="weak">Crawler-only · weak</option><option value="listed">Listed</option><option value="pending">May still be listed</option><option value="possible">Possible match</option><option value="not_comparable">Not comparable</option></select></label>
          <span className="reconcile-updated">Updated {time(data?.generatedAt)} UTC<SnapshotAge generatedAt={data?.generatedAt} cache={data?.cache} /></span>
        </div>
        <div className="reconcile-notice crawler-only-caveat">Absent from the 10-minute sample is not proof the provider lacks the article.</div>
        <p className="reconcile-definition crawler-only-intro">Read-only comparison using stored Google News and Exa results. This page makes no provider calls and spends no quota. Articles younger than 70 minutes may still appear in a later poll.</p>
        {error && <div className="reconcile-notice" role="alert">{error}{data ? " Showing the previous snapshot." : " Try refreshing."}</div>}
        {loading && !data && <div className="reconcile-notice" role="status">Loading crawler-only comparison…</div>}
        {data && !data.ready && !loading && <div className="reconcile-notice" role="status">Waiting for stored provider results. No provider calls are made by this page.</div>}
        <div className="reconcile-stats crawler-only-stats" aria-live="polite" aria-busy={loading}>
          <section className="coverage-hero"><span>Crawler-only · sample evidence</span><strong>{number(summary?.crawlerOnly)}</strong><p>{number(summary?.strong)} strong · {number(summary?.weak)} weak</p><small>Strong: latest covering polls were under cap. Weak: at least one latest covering poll was capped.</small></section>
          <section><span>Listed in a provider sample</span><strong>{number(summary?.listed)}</strong><p>{provider === "exa" ? `Exa ${number(summary?.exaOnly)}` : provider === "google" ? `Google ${number(summary?.googleOnly)}` : `Google only ${number(summary?.googleOnly)} · Exa only ${number(summary?.exaOnly)} · Both ${number(summary?.both)}`}</p><small>Confirmed by the same matcher as Coverage.</small></section>
          <section><span>Provider may still list it</span><strong>{number(summary?.pending)}</strong><p>Published less than 70 minutes ago.</p><small>Not yet graded as crawler-only.</small></section>
          <section><span>Not comparable</span><strong>{number(summary?.notComparable)}</strong><p>No successful covering poll or saved fetch evidence.</p><small>Provider failure is not evidence of absence.</small></section>
        </div>
        <div className="crawler-only-sample">
          <span><b>{number(summary?.total)}</b> parsed, dated records in this window</span>
          <span><b>{number(summary?.comparable)}</b> comparable</span>
          <button className="crawler-only-inline" onClick={() => { setShow("possible"); setPage(1); }}><b>{number(summary?.possible)}</b> possible title matches</button>
        </div>
        <p className="reconcile-definition">“Strong” and “weak” grade evidence from saved samples; neither proves exclusivity. A possible match has the same normalized title but no confirmed Coverage match. Window membership uses publication time. Incomplete parsed records are included and marked below; records without a publication date and unparsed downloads are outside this view.</p>
        <section className="reconcile-panel">
          <div className="panel-heading"><div><h2>By domain</h2><p>Counts are exact for the selected population. Cap shares use successful polls covering this window.</p></div></div>
          <div className="reconcile-table crawler-domain-table"><table>
            <thead><tr><th>Domain</th><th>Comparable</th><th>Listed</th><th>Possible</th><th>Strong</th><th>Weak</th><th>Pending</th><th>Not comparable</th><th>Google capped polls</th><th>Exa capped polls</th></tr></thead>
            <tbody>{(data?.domains || []).map((domain: Row) => <tr key={domain.site}>
              <td><button onClick={() => { setSite(domain.site); setPage(1); }} title={`Filter to ${domain.site}`}>{domain.site}</button></td>
              <td>{number(domain.comparable)}</td><td>{number(domain.listed)}</td><td>{number(domain.possible)}</td><td>{number(domain.strong)}</td><td>{number(domain.weak)}</td><td>{number(domain.pending)}</td><td>{number(domain.notComparable)}</td>
              <td><PollCap value={domain.polls?.google} provider="google" /></td><td><PollCap value={domain.polls?.exa} provider="exa" /></td>
            </tr>)}</tbody>
          </table></div>
          {!data?.domains?.length && <div className="reconcile-empty">{loading ? "Loading domain evidence…" : "No domains match these filters."}</div>}
        </section>
        <section className="reconcile-panel">
          <div className="panel-heading"><div><h2>Article records</h2><p>Newest publication first · 50 records per page · all times UTC. Hover over provider statuses for evidence.</p></div></div>
          {limited && <div className="crawler-only-limit" role="status">Details retain only the newest {number(data?.rowsLimit || 2000)} records; totals above remain exact. Narrow the domain or time window to inspect older matches.</div>}
          <div className="reconcile-table crawler-only-table"><table>
            <thead><tr><th>Article / URL</th><th>Published UTC</th><th>Fetched UTC</th><th>Google News</th><th>Exa</th></tr></thead>
            <tbody>{(data?.articles || []).map((article: Row) => <tr key={article.url}>
              <td className="crawler-only-article"><a href={safeUrl(article.url)} target="_blank" rel="noreferrer">{article.title || article.url}</a><small className="crawler-only-url" title={article.url}>{article.url}</small><small>{article.site}</small>{article.incomplete && <small className="crawler-only-incomplete">Incomplete parse</small>}<span className="crawler-status" data-status={article.status}>{labels[article.status] || "Not comparable"}</span></td>
              <td>{time(article.publishedAt)}</td>
              <td>{time(article.fetchFinishedAt)}{article.requestId && <small><a href={`/api/requests/${article.requestId}`} target="_blank" rel="noreferrer">Fetch #{article.requestId}</a></small>}</td>
              <td><ProviderStatus evidence={article.google} provider="google" /></td><td><ProviderStatus evidence={article.exa} provider="exa" /></td>
            </tr>)}</tbody>
          </table></div>
          {!data?.articles?.length && <div className="reconcile-empty">{loading ? "Loading article records…" : limited && data?.groupCount ? "No retained recent rows match this filter. Narrow the domain or publication window." : "No article records match these filters."}</div>}
          <div className="timing-pagination"><span>{number(data?.groupCount)} matching records{limited ? ` · ${number(data?.rowCount)} retained` : ""} · Page {page} of {Math.max(1, data?.pageCount || 0)}</span><Button variant="outline" size="sm" disabled={loading || page <= 1} onClick={() => setPage(value => value - 1)}>Previous</Button><Button variant="outline" size="sm" disabled={loading || page >= (data?.pageCount || 0)} onClick={() => setPage(value => value + 1)}>Next</Button></div>
        </section>
        {data?.population && <p className="reconcile-definition crawler-only-population">Across stored history for the selected domains: {number(data.population.undatedExcluded)} undated parsed records and {number(data.population.unparsedExcluded)} unparsed downloads are excluded. They cannot be graded in a publication-time window here.</p>}
      </div>
    </main>
  </div>;
}
