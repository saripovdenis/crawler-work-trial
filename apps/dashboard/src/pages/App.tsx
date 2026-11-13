import { Alerts, PageHead, Shell, type View } from "@/components/Shell";
import { Updated } from "@/components/Updated";
import { useCallback, useEffect, useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

type Row = Record<string, any>;
type Tab = "overview" | "requests" | "articles";
const titles: Record<Tab, string> = { overview: "Overview", requests: "Requests", articles: "Articles" };
const number = (n: number | undefined) => (n == null ? "—" : n.toLocaleString("en-US"));
// Every page shows UTC.
const time = (n: number | string | null) => {
  const d = n ? new Date(n) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(11, 19) : "—";
};
const fullDate = (n: number | string | null) => {
  if (!n) return "—";
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? String(n) : d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
};
const delay = (n: number | null) =>
  n == null ? "—" : n < 60 ? `${Math.round(n)}s` : n < 3600 ? `${(n / 60).toFixed(1)}m` : `${(n / 3600).toFixed(1)}h`;
const safeUrl = (url: string) => (/^https?:\/\//i.test(url) ? url : "#");
async function json(path: string, signal?: AbortSignal) {
  const r = await fetch(path, { signal });
  if (!r.ok) throw new Error(`Data service returned ${r.status}`);
  return r.json();
}
function Status({ row }: { row: Row }) {
  const tone = row.error || row.status >= 400 ? "bad" : row.status === 304 ? "faint" : "";
  return <span className={`code ${tone}`}>{row.error ? "error" : row.status || "…"}</span>;
}

function ArticleDetails({ row }: { row: Row }) {
  const [article, setArticle] = useState<Row | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setArticle(null); setError(""); setCopied(false);
    json(`/api/articles/${row.id}`, controller.signal)
      .then(value => { if (!controller.signal.aborted) setArticle(value.article); })
      .catch(() => { if (!controller.signal.aborted) setError("Could not load the stored article."); });
    return () => controller.abort();
  }, [row.id, retry]);
  const storedJson = article ? JSON.stringify(article, null, 2) : "";
  return <>
    <h2 dir="auto">{article?.title || row.title}</h2>
    <a className="link url-full" href={safeUrl(article?.canonicalUrl || row.url)} target="_blank" rel="noopener noreferrer">Open original ↗</a>
    {(article?.description || row.description) && <p dir="auto">{article?.description ?? row.description}</p>}
    <dl>
      <dt>Website</dt><dd>{row.domain}</dd>
      <dt>Classification</dt><dd>{article?.classification || row.classification}</dd>
      <dt>Published</dt><dd>{fullDate(article?.publishedAt || row.published)}</dd>
      <dt>Modified</dt><dd>{article ? fullDate(article.modifiedAt) : "Loading…"}</dd>
      <dt>First discovered</dt><dd>{fullDate(article?.discoveredAt || row.discovered)}</dd>
      <dt>Parsed</dt><dd>{fullDate(row.fetched)}</dd>
      <dt>Date evidence</dt><dd>{article?.dateSource || row.dateSource || "Unknown"}</dd>
      <dt>Extracted text</dt><dd>{number(article ? article.text?.length : row.textLength)} characters</dd>
    </dl>
    <section aria-label="Stored article JSON">
      <div className="article-json-heading">
        <h3>Stored JSON</h3>
        {article && <button onClick={async () => {
          try { await navigator.clipboard.writeText(storedJson); setCopied(true); }
          catch { setError("Copy failed. Select the JSON below to copy it."); }
        }}>{copied ? "Copied" : "Copy JSON"}</button>}
      </div>
      {error && <p role="alert">{error} {!article && <button onClick={() => setRetry(value => value + 1)}>Retry</button>}</p>}
      {!article && !error && <p role="status">Loading stored JSON…</p>}
      {article && <pre className="article-json" tabIndex={0} aria-label="Complete stored article JSON"><code>{storedJson}</code></pre>}
    </section>
  </>;
}

export default function App() {
  const [tab, setTab] = useState<Tab>(() => {
    const view = new URLSearchParams(location.search).get("view");
    return view && view in titles ? (view as Tab) : "overview";
  });
  const [overview, setOverview] = useState<Row | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [domain, setDomain] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [freshOnly, setFreshOnly] = useState(true);
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState<number | null>(null);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<Row | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const changeTab = (t: Tab) => {
    setTab(t);
    setRows([]);
    setLoading(true);
    setCursor(null);
    const u = new URL(location.href);
    if (t === "overview") u.searchParams.delete("view");
    else u.searchParams.set("view", t);
    history.replaceState(null, "", u);
  };
  const selectView = (view: View) => {
    if (!(view in titles)) return false;
    changeTab(view as Tab);
    return true;
  };
  const selectDomain = (d: string) => {
    setDomain(d);
    setCursor(null);
  };
  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        // Each list gets only the filters its endpoint reads; Overview has no list.
        const params = new URLSearchParams();
        if (domain) params.set("domain", domain);
        if (tab === "requests" && errorsOnly) params.set("errors", "true");
        if (tab === "articles" && freshOnly) params.set("fresh", "true");
        if (tab === "articles" && search) params.set("q", search);
        if (cursor) params.set("before", String(cursor));
        const [summary, list] = await Promise.all([
          json("/api/overview", signal),
          tab === "overview" ? null : json(`/api/${tab}?${params}`, signal),
        ]);
        setOverview(summary);
        setRows(list?.items ?? []);
        setNextCursor(list?.nextCursor || null);
        setError("");
      } catch (e) {
        if (!signal?.aborted) setError(String(e));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [tab, domain, errorsOnly, freshOnly, search, cursor],
  );
  useEffect(() => {
    const control = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => load(control.signal), 150);
    const interval = setInterval(() => {
      if (!document.hidden) load(control.signal);
    }, 10_000);
    return () => {
      control.abort();
      clearTimeout(timer);
      clearInterval(interval);
    };
  }, [load]);
  const inspect = async (row: Row) => {
    setDetail({ type: "request", ...row });
    setDetailLoading(true);
    try {
      setDetail({ type: "request", ...(await json(`/api/requests/${row.id}`)) });
    } catch {
      setDetail((d) => ({ ...d, snapshotNote: "Could not load response details." }));
    } finally {
      setDetailLoading(false);
    }
  };
  const totals = overview?.totals;
  const sites: Row[] = overview?.sites || [];
  const siteSelect = (
    <select aria-label="Filter by website" value={domain} onChange={(e) => selectDomain(e.target.value)}>
      <option value="">All websites</option>
      {sites.map((s) => <option key={s.domain} value={s.domain}>{s.domain}</option>)}
    </select>
  );
  return (
    <Shell active={tab} onSelect={selectView}>
      <PageHead title={titles[tab]}>
        <Updated at={overview?.generatedAt} staleLimitMs={overview?.cache?.staleLimitMs} />
      </PageHead>
      <Alerts
        items={[
          error && `${error}. ${overview ? "Showing the last received data." : "Retrying."}`,
          overview && !overview.running && "Collector heartbeat is stale. These are the last saved results.",
        ]}
      />
      {tab === "overview" && (
        <>
          <section className="stats stats-4">
            <div className="stat">
              <span className="label">Fresh articles</span>
              <strong>{number(totals?.fresh)}</strong>
            </div>
            <div className="stat">
              <span className="label">Sites responding</span>
              <strong>
                {number(totals?.respondingSites)}
                <em> / {overview ? sites.length : "—"}</em>
              </strong>
            </div>
            <div className="stat">
              <span className="label">Median discovery delay</span>
              <strong>{delay(totals?.p50Delay ?? null)}</strong>
              <small>p95 {delay(totals?.p95Delay ?? null)}</small>
            </div>
            <div className="stat">
              <span className="label">Requests</span>
              <strong>{number(totals?.requests)}</strong>
              <small>{number(totals?.errors)} failed</small>
            </div>
          </section>
          <table className="tbl">
            <thead>
              <tr>
                <th>Website</th>
                <th className="num">Fresh</th>
                <th className="num">Requests / min</th>
                <th className="num">Budget eligible</th>
                <th className="num hide-sm">Last request</th>
              </tr>
            </thead>
            <tbody>
              {sites.map((s) => {
                const paused = s.enabled === false;
                const wait = s.nextEligible == null ? null : s.nextEligible - Date.now();
                return (
                  <tr key={s.domain}>
                    <td>
                      <button className="link" onClick={() => { selectDomain(s.domain); changeTab("requests"); }}>
                        {s.domain}
                      </button>
                    </td>
                    <td className="num">{number(s.fresh)}</td>
                    <td className="num">
                      {s.usedThisMinute}
                      <span className="faint"> / {paused ? "—" : s.currentLimit}</span>
                    </td>
                    {/* Blank while a site is due; a long wait means a cooldown. */}
                    <td className="num">
                      {paused ? "Paused" : wait == null ? <span className="faint">Not initialized</span> : wait > 60_000 ? `in ${delay(wait / 1000)}` : ""}
                    </td>
                    <td className="num faint hide-sm">{time(s.lastRequest)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
      {tab === "requests" && (
        <>
          <div className="toolbar">
            {siteSelect}
            <label className="check">
              <input type="checkbox" checked={errorsOnly} onChange={() => { setErrorsOnly(!errorsOnly); setCursor(null); }} />
              Errors only
            </label>
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th>Time</th>
                <th>URL</th>
                <th className="hide-sm">Purpose</th>
                <th className="num">Status</th>
                <th className="num">Duration</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => inspect(r)}>
                  <td className="faint mono">{time(r.started)}</td>
                  <td>
                    {/* The click bubbles to the row; the button keeps the row keyboard-reachable. */}
                    <button type="button" className="url" title="Inspect this request">{r.url}</button>
                  </td>
                  <td className="faint hide-sm">{r.purpose}</td>
                  <td className="num"><Status row={r} /></td>
                  <td className="num">{r.finished ? `${number(r.finished - r.started)} ms` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <Empty loading={loading} />}
          <Pagination cursor={cursor} next={nextCursor} set={setCursor} />
        </>
      )}
      {tab === "articles" && (
        <>
          <div className="toolbar">
            <input
              type="search"
              value={search}
              placeholder="Search titles"
              aria-label="Search article titles"
              onChange={(e) => { setSearch(e.target.value); setCursor(null); }}
            />
            {siteSelect}
            <label className="check">
              <input type="checkbox" checked={freshOnly} onChange={() => { setFreshOnly(!freshOnly); setCursor(null); }} />
              Fresh only
            </label>
          </div>
          <div className="articles">
            {rows.map((r) => (
              <button className="article" key={r.id} onClick={() => setDetail({ type: "article", ...r })}>
                <span className="meta">
                  {r.domain} · {time(r.discovered)}
                  {r.classification !== "new" && ` · ${r.classification.replaceAll("_", " ")}`}
                </span>
                <span className="title" dir="auto">{r.title || r.url}</span>
                {r.description && <span className="desc" dir="auto">{r.description}</span>}
              </button>
            ))}
          </div>
          {!rows.length && <Empty loading={loading} />}
          <Pagination cursor={cursor} next={nextCursor} set={setCursor} />
        </>
      )}
      <Sheet open={!!detail} onOpenChange={(open) => { if (!open) setDetail(null); }}>
        <SheetContent className="detail-sheet">
          <SheetHeader>
            <SheetTitle>{detail?.type === "article" ? "Article" : `Request ${detail?.id || ""}`}</SheetTitle>
          </SheetHeader>
          {detail && (
            <div className="detail">
              {detail.type === "article" ? (
                <ArticleDetails key={detail.id} row={detail} />
              ) : (
                <>
                  <a className="link url-full" href={safeUrl(detail.url)} target="_blank" rel="noreferrer">{detail.url} ↗</a>
                  <dl>
                    <dt>Status</dt><dd><Status row={detail} /></dd>
                    <dt>Purpose</dt><dd>{detail.purpose}</dd>
                    <dt>Started</dt><dd>{fullDate(detail.started)}</dd>
                    <dt>Duration</dt><dd>{detail.finished ? `${number(detail.finished - detail.started)} ms` : "In flight"}</dd>
                  </dl>
                  {detail.error && <Alerts items={[detail.error]} />}
                  {detail.purpose === "discovery" && (
                    <section>
                      <h3>Links in this response <span className="faint">{detail.linkCount ?? "—"}</span></h3>
                      {detailLoading ? (
                        <p className="faint">Loading saved response…</p>
                      ) : detail.links?.length ? (
                        <div className="links">
                          {detail.links.map((link: Row) => (
                            <a key={link.url} href={safeUrl(link.url)} target="_blank" rel="noreferrer">{link.url}</a>
                          ))}
                        </div>
                      ) : (
                        <p className="faint">
                          {detail.snapshotNote ||
                            (detail.status === 304 ? "Not modified — the server returned no new body." : "No candidate links in this response.")}
                        </p>
                      )}
                      {detail.linkCount > 200 && <p className="faint">Showing the first 200 candidate links.</p>}
                    </section>
                  )}
                </>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </Shell>
  );
}
function Empty({ loading }: { loading: boolean }) {
  return <p className="empty">{loading ? "Loading…" : "No matching results"}</p>;
}
function Pagination({ cursor, next, set }: { cursor: number | null; next: number | null; set: (n: number | null) => void }) {
  return (
    <div className="pagination">
      <button disabled={!cursor} onClick={() => set(null)}>Latest</button>
      <button disabled={!next} onClick={() => set(next)}>Older →</button>
    </div>
  );
}
