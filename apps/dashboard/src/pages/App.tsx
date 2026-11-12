import { Sidebar, type View } from "@/components/Sidebar";
import { SnapshotAge } from "@/components/SnapshotAge";
import { useCallback, useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowUpRight,
  Check,
  CircleHelp,
  ExternalLink,
  ListFilter,
  Pause,
  Play,
  RefreshCw,
  Search,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import "./App.css";

type Row = Record<string, any>;
type Tab = "overview" | "requests" | "articles" | "schedule";
const titles: Record<Tab, string> = {
  overview: "Overview",
  requests: "Request log",
  articles: "Articles",
  schedule: "Poll schedule",
};
const number = (n: number | undefined) =>
  n == null ? "—" : new Intl.NumberFormat("en-US").format(n);
// Every page shows UTC, matching Coverage and Freshness.
const time = (n: number | string | null) => {
  const d = n ? new Date(n) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(11, 19) : "—";
};
const fullDate = (n: number | string | null) => {
  if (!n) return "Not available";
  const d = new Date(n);
  return Number.isNaN(d.getTime())
    ? String(n)
    : d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
};
const delay = (n: number | null) =>
  n == null
    ? "—"
    : n < 60
      ? `${Math.round(n)}s`
      : n < 3600
        ? `${(n / 60).toFixed(1)}m`
        : `${(n / 3600).toFixed(1)}h`;
const due = (n: number) =>
  n <= Date.now() ? "Eligible now" : `in ${delay((n - Date.now()) / 1000)}`;
const safeUrl = (url: string) => (/^https?:\/\//i.test(url) ? url : "#");
async function json(path: string, signal?: AbortSignal) {
  const r = await fetch(path, { signal });
  if (!r.ok) throw new Error(`Data service returned ${r.status}`);
  return r.json();
}
function Status({ row }: { row: Row }) {
  return (
    <Badge
      variant="outline"
      className={`status ${row.error || row.status >= 400 ? "status-error" : row.status === 304 ? "status-muted" : "status-ok"}`}
    >
      {row.error ? "Error" : row.status || "In flight"}
    </Badge>
  );
}

export default function App() {
  const [tab, setTab] = useState<Tab>(() => {
    const view = new URLSearchParams(location.search).get("view");
    return view && view in titles ? (view as Tab) : "overview";
  });
  const [overview, setOverview] = useState<Row | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [domain, setDomain] = useState("");
  const [live, setLive] = useState(true);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [freshOnly, setFreshOnly] = useState(true);
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState<number | null>(null);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<Row | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const changeTab = (t: Tab) => {
    setTab(t);
    setRows([]);
    setLoading(true);
    setCursor(null);
    const u = new URL(location.href);
    u.searchParams.set("view", t);
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
        if (cursor && tab !== "schedule") params.set("before", String(cursor));
        const endpoint =
          tab === "schedule"
            ? "sources"
            : tab === "overview"
              ? null
              : tab;
        const [summary, list] = await Promise.all([
          json("/api/overview", signal),
          endpoint ? json(`/api/${endpoint}?${params}`, signal) : null,
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
    const interval = live
      ? setInterval(() => {
          if (!document.hidden) load(control.signal);
        }, 10_000)
      : undefined;
    return () => {
      control.abort();
      clearTimeout(timer);
      clearInterval(interval);
    };
  }, [load, live, reload]);
  const inspect = async (row: Row) => {
    setDetail({ type: "request", ...row });
    setDetailLoading(true);
    try {
      setDetail({
        type: "request",
        ...(await json(`/api/requests/${row.id}`)),
      });
    } catch {
      setDetail((d) => ({
        ...d,
        snapshotNote: "Could not load response details.",
      }));
    } finally {
      setDetailLoading(false);
    }
  };
  const totals = overview?.totals;
  const sites: Row[] = overview?.sites || [];
  const running = overview?.running;
  return (
    <div className="app-shell">
      <Sidebar active={tab} onSelect={selectView} />
      <main>
        <div className="content">
          <div className="page-heading">
            <h1>{titles[tab]}</h1>
            <div className="heading-actions">
              <Button
                variant="outline"
                className="refresh"
                onClick={() => setReload((n) => n + 1)}
                aria-label="Refresh data"
              >
                <RefreshCw size={15} className={loading ? "spin" : ""} />
              </Button>
              <Button
                className={live ? "live-button" : "paused-button"}
                onClick={() => setLive(!live)}
              >
                {live ? (
                  <>
                    <span className="live-dot" />
                    Live updates
                    <Pause size={13} />
                  </>
                ) : (
                  <>
                    <Play size={14} />
                    Resume updates
                  </>
                )}
              </Button>
            </div>
          </div>
          {error && (
            <div className="error-banner">
              <CircleHelp size={17} />
              {error}.{" "}
              {overview
                ? "Showing the last received data."
                : "Retrying when live updates are enabled."}
            </div>
          )}
          {overview && !running && (
            <div className="error-banner">
              Collector heartbeat is stale. These are the last saved results.
            </div>
          )}
          <div className="filter-bar">
            <div className="filters">
              {tab !== "overview" && (
                <select
                  aria-label="Filter by website"
                  value={domain}
                  onChange={(e) => selectDomain(e.target.value)}
                >
                  <option value="">All websites</option>
                  {sites.map((s) => (
                    <option key={s.domain} value={s.domain}>
                      {s.domain}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <span className="updated">
              <span className={`dot ${live ? "green" : "gray"}`} />
              {overview
                ? `Updated ${time(overview.generatedAt)} UTC`
                : "Connecting…"}
              <SnapshotAge generatedAt={overview?.generatedAt} cache={overview?.cache} />
            </span>
          </div>
          {tab === "overview" && (
            <>
              <section
                className="metrics"
                aria-label="All-time crawler metrics"
              >
                <div className="metric">
                  <span>Fresh articles</span>
                  <strong>{number(totals?.fresh)}</strong>
                </div>
                <div className="metric">
                  <span>Websites responding</span>
                  <strong>
                    {number(totals?.respondingSites)}
                    <em>/{overview ? sites.length : "—"}</em>
                  </strong>
                </div>
                <div className="metric">
                  <span>Median discovery delay</span>
                  <strong>{delay(totals?.p50Delay ?? null)}</strong>
                  <small>
                    From publisher timestamps · {number(totals?.delaySamples)}{" "}
                    samples
                  </small>
                </div>
                <div className="metric">
                  <span>Total requests</span>
                  <strong>{number(totals?.requests)}</strong>
                  <small>{number(totals?.errors)} failed attempts</small>
                </div>
              </section>
              <section className="panel chart-panel">
                <div className="panel-header">
                  <div>
                    <h2>Discovery activity</h2>
                    <p>Per 5 minutes, last hour (UTC)</p>
                  </div>
                </div>
                <div className="chart-legend">
                  <span>
                    <i style={{ background: "#1840ed" }} />
                    Requests
                  </span>
                  <span>
                    <i style={{ background: "#20a078" }} />
                    Fresh articles
                  </span>
                  <span>
                    <i style={{ background: "#dc9366" }} />
                    Errors
                  </span>
                </div>
                <div className="activity-chart">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart
                      data={overview?.series || []}
                      margin={{ top: 10, right: 8, left: -26, bottom: 0 }}
                    >
                      <defs>
                        <linearGradient
                          id="blueArea"
                          x1="0"
                          y1="0"
                          x2="0"
                          y2="1"
                        >
                          <stop
                            offset="0%"
                            stopColor="#1840ed"
                            stopOpacity={0.12}
                          />
                          <stop
                            offset="100%"
                            stopColor="#1840ed"
                            stopOpacity={0}
                          />
                        </linearGradient>
                      </defs>
                      <CartesianGrid
                        vertical={false}
                        stroke="#eeeef1"
                        strokeDasharray="3 4"
                      />
                      <XAxis
                        dataKey="time"
                        tickFormatter={(n) => time(n).slice(0, 5)}
                        axisLine={false}
                        tickLine={false}
                        tick={{ fontSize: 11, fill: "#93949c" }}
                        minTickGap={35}
                      />
                      <YAxis
                        axisLine={false}
                        tickLine={false}
                        tick={{ fontSize: 11, fill: "#93949c" }}
                      />
                      <Tooltip
                        labelFormatter={(n) => fullDate(Number(n))}
                        contentStyle={{
                          borderRadius: 8,
                          border: "1px solid #e9e9ed",
                          fontSize: 12,
                        }}
                      />
                      <Area
                        type="linear"
                        dataKey="requests"
                        stroke="#1840ed"
                        strokeWidth={2}
                        fill="url(#blueArea)"
                        isAnimationActive={false}
                      />
                      <Area
                        type="linear"
                        dataKey="fresh"
                        stroke="#20a078"
                        strokeWidth={1.5}
                        fill="none"
                        isAnimationActive={false}
                      />
                      <Area
                        type="linear"
                        dataKey="errors"
                        stroke="#dc9366"
                        strokeWidth={1.5}
                        fill="none"
                        isAnimationActive={false}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </section>
              <section className="panel">
                <div className="panel-header">
                  <h2>Website health</h2>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Website</TableHead>
                      <TableHead>Fresh articles</TableHead>
                      <TableHead>Request budget / min</TableHead>
                      <TableHead>Next poll eligible</TableHead>
                      <TableHead className="text-right">
                        Last request UTC
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sites.map((s) => (
                      <TableRow key={s.domain}>
                        <TableCell>
                          <button
                            className="site-link"
                            onClick={() => {
                              selectDomain(s.domain);
                              changeTab("requests");
                            }}
                          >
                            {s.domain}
                          </button>
                        </TableCell>
                        <TableCell className="numeric">
                          {number(s.fresh)}
                        </TableCell>
                        <TableCell>
                          <div className="budget">
                            <div>
                              <i
                                style={{
                                  width: `${Math.min(100, (s.usedThisMinute / s.currentLimit) * 100)}%`,
                                }}
                              />
                            </div>
                            <span>
                              {s.usedThisMinute}
                              <em> / {s.currentLimit}</em>
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <span
                            className={
                              s.nextEligible <= Date.now() ? "eligible" : ""
                            }
                          >
                            {due(s.nextEligible)}
                          </span>
                        </TableCell>
                        <TableCell className="text-right muted numeric">
                          {time(s.lastRequest)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </section>
            </>
          )}
          {tab === "requests" && (
            <section className="panel">
              <div className="panel-header tools-only">
                <Button
                  variant={errorsOnly ? "default" : "outline"}
                  size="sm"
                  onClick={() => {
                    setErrorsOnly(!errorsOnly);
                    setCursor(null);
                  }}
                >
                  <ListFilter size={14} />
                  {errorsOnly ? "Errors only" : "Show errors"}
                </Button>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time UTC</TableHead>
                    <TableHead>URL</TableHead>
                    <TableHead>Purpose</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Duration</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow
                      key={r.id}
                      className="clickable-row"
                      onClick={() => inspect(r)}
                    >
                      <TableCell className="numeric muted">
                        {time(r.started)}
                      </TableCell>
                      <TableCell>
                        {/* The click bubbles to the row; the button keeps the row keyboard-reachable. */}
                        <button
                          type="button"
                          className="row-url"
                          title="Inspect this request"
                        >
                          {r.url}
                        </button>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{r.purpose}</Badge>
                      </TableCell>
                      <TableCell>
                        <Status row={r} />
                      </TableCell>
                      <TableCell className="numeric">
                        {r.finished
                          ? `${number(r.finished - r.started)} ms`
                          : "Pending"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {!rows.length && <Empty loading={loading} />}
              <Pagination cursor={cursor} next={nextCursor} set={setCursor} />
            </section>
          )}
          {tab === "articles" && (
            <section className="panel">
              <div className="panel-header article-tools tools-only">
                <div className="article-filters">
                  <div className="search-box">
                    <Search size={15} />
                    <Input
                      value={search}
                      placeholder="Search titles…"
                      aria-label="Search article titles"
                      onChange={(e) => {
                        setSearch(e.target.value);
                        setCursor(null);
                      }}
                    />
                  </div>
                  <Button
                    variant={freshOnly ? "default" : "outline"}
                    size="sm"
                    onClick={() => {
                      setFreshOnly(!freshOnly);
                      setCursor(null);
                    }}
                  >
                    {freshOnly ? <Check size={14} /> : <ListFilter size={14} />}
                    Fresh only
                  </Button>
                </div>
              </div>
              {rows.map((r) => (
                <button
                  className="article-row"
                  key={r.id}
                  onClick={() => setDetail({ type: "article", ...r })}
                >
                  <div className="article-main">
                    <div className="article-meta">
                      <span>{r.domain}</span>
                      <span>·</span>
                      <span>{time(r.discovered)}</span>
                      <Badge
                        variant="outline"
                        className={
                          r.classification === "new" ? "status-ok" : ""
                        }
                      >
                        {r.classification === "new"
                          ? "Fresh"
                          : r.classification.replaceAll("_", " ")}
                      </Badge>
                    </div>
                    <h3 dir="auto">{r.title || r.url}</h3>
                    {r.description && <p dir="auto">{r.description}</p>}
                  </div>
                </button>
              ))}
              {!rows.length && <Empty loading={loading} />}
              <Pagination cursor={cursor} next={nextCursor} set={setCursor} />
            </section>
          )}
          {tab === "schedule" && (
            <section className="panel">
              <div className="panel-header">
                <div>
                  <h2>Upcoming source polls</h2>
                  <p>
                    Eligibility is a minimum wait. Budgets, retries, and queued
                    articles can delay execution.
                  </p>
                </div>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Source</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead>Eligible</TableHead>
                    <TableHead>Successful polls</TableHead>
                    <TableHead>URLs discovered</TableHead>
                    <TableHead>State</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.url}>
                      <TableCell>
                        <a
                          className="row-url"
                          href={safeUrl(r.url)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {r.url}
                        </a>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{r.kind}</Badge>
                      </TableCell>
                      <TableCell
                        className={
                          r.nextEligible <= Date.now() ? "eligible" : ""
                        }
                      >
                        {due(r.nextEligible)}
                      </TableCell>
                      <TableCell className="numeric">
                        {number(r.polls)}
                      </TableCell>
                      <TableCell className="numeric">
                        {number(r.discovered)}
                      </TableCell>
                      <TableCell>
                        {!!r.errors && (
                          <span
                            className="error-text"
                            title={r.lastError || ""}
                          >
                            {r.errors} consecutive failures
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </section>
          )}
        </div>
      </main>
      <Sheet
        open={!!detail}
        onOpenChange={(open) => {
          if (!open) setDetail(null);
        }}
      >
        <SheetContent className="detail-sheet">
          <SheetHeader>
            <SheetTitle>
              {detail?.type === "article"
                ? "Article"
                : `Request #${detail?.id || ""}`}
            </SheetTitle>
          </SheetHeader>
          {detail && (
            <div className="detail-content">
              {detail.type === "article" ? (
                <>
                  <h2 dir="auto">{detail.title}</h2>
                  <p dir="auto">{detail.description}</p>
                  <dl>
                    <dt>Website</dt>
                    <dd>{detail.domain}</dd>
                    <dt>Classification</dt>
                    <dd>{detail.classification}</dd>
                    <dt>Published</dt>
                    <dd>{fullDate(detail.published)}</dd>
                    <dt>First discovered</dt>
                    <dd>{fullDate(detail.discovered)}</dd>
                    <dt>Fetched</dt>
                    <dd>{fullDate(detail.fetched)}</dd>
                    <dt>Date evidence</dt>
                    <dd>{detail.dateSource || "Unknown"}</dd>
                    <dt>Extracted text</dt>
                    <dd>{number(detail.textLength)} characters</dd>
                  </dl>
                  <Button
                    render={
                      <a
                        href={safeUrl(detail.url)}
                        target="_blank"
                        rel="noreferrer"
                      />
                    }
                  >
                    Read original
                    <ExternalLink size={15} />
                  </Button>
                </>
              ) : (
                <>
                  <Status row={detail} />
                  <a
                    className="detail-url"
                    href={safeUrl(detail.url)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {detail.url}
                    <ExternalLink size={13} />
                  </a>
                  <dl>
                    <dt>Purpose</dt>
                    <dd>{detail.purpose}</dd>
                    <dt>Started</dt>
                    <dd>{fullDate(detail.started)}</dd>
                    <dt>Duration</dt>
                    <dd>
                      {detail.finished
                        ? `${number(detail.finished - detail.started)} ms`
                        : "In flight"}
                    </dd>
                  </dl>
                  {detail.error && (
                    <div className="error-banner">{detail.error}</div>
                  )}
                  {detail.purpose === "discovery" && (
                    <div className="detail-section">
                      <h3>
                        Links in this response{" "}
                        <Badge variant="outline">
                          {detail.linkCount ?? "—"}
                        </Badge>
                      </h3>
                      {detailLoading ? (
                        <div className="empty-state">
                          Loading saved response…
                        </div>
                      ) : detail.links?.length ? (
                        <div className="snapshot-links">
                          {detail.links.map((link: Row) => (
                            <a
                              key={link.url}
                              href={safeUrl(link.url)}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {link.url}
                              <ArrowUpRight size={13} />
                            </a>
                          ))}
                        </div>
                      ) : (
                        <div className="empty-state">
                          {detail.snapshotNote ||
                            (detail.status === 304
                              ? "Not modified — the server returned no new body."
                              : "No candidate links in this response.")}
                        </div>
                      )}
                      {detail.linkCount > 200 && (
                        <p>Showing the first 200 candidate links.</p>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
function Empty({ loading }: { loading: boolean }) {
  return (
    <div className="empty-state">
      <Search size={24} />
      <strong>
        {loading ? "Loading collector data…" : "No matching results yet"}
      </strong>
    </div>
  );
}
function Pagination({
  cursor,
  next,
  set,
}: {
  cursor: number | null;
  next: number | null;
  set: (n: number | null) => void;
}) {
  return (
    <div className="pagination">
      <Button
        variant="outline"
        size="sm"
        disabled={!cursor}
        onClick={() => set(null)}
      >
        Latest
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={!next}
        onClick={() => set(next)}
      >
        Older
        <ArrowDown size={13} />
      </Button>
    </div>
  );
}
