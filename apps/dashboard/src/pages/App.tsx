import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  BarChart3,
  ScanSearch,
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleHelp,
  Clock3,
  Code2,
  Database,
  ExternalLink,
  FileText,
  GitBranch,
  Globe2,
  LayoutDashboard,
  ListFilter,
  Pause,
  Play,
  RefreshCw,
  Search,
  Radio,
  X,
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
  SheetDescription,
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
const tabs: { id: Tab; label: string; icon: typeof Activity }[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "requests", label: "Request log", icon: Activity },
  { id: "articles", label: "Articles", icon: FileText },
  { id: "schedule", label: "Poll schedule", icon: Clock3 },
];
const number = (n: number | undefined) =>
  n == null ? "—" : new Intl.NumberFormat("en-US").format(n);
const time = (n: number | string | null) =>
  n
    ? new Date(n).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      })
    : "—";
const fullDate = (n: number | string | null) =>
  n ? new Date(n).toLocaleString() : "Not available";
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
function Health({ state }: { state: string }) {
  return (
    <span className={`health ${state}`}>
      <i />
      {state === "healthy"
        ? "Healthy"
        : state === "degraded"
          ? "Degraded"
          : "Blocked"}
    </span>
  );
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
function Domain({ name }: { name: string }) {
  return (
    <span className="domain">
      <span className="domain-icon">{name.substring(0, 2)}</span>
      {name}
    </span>
  );
}

export default function App() {
  const [tab, setTab] = useState<Tab>(
    () =>
      (new URLSearchParams(location.search).get("view") as Tab) || "overview",
  );
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
  const selectDomain = (d: string) => {
    setDomain(d);
    setCursor(null);
  };
  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const params = new URLSearchParams({
          domain,
          errors: String(errorsOnly),
          fresh: String(freshOnly),
          q: search,
        });
        if (cursor) params.set("before", String(cursor));
        const endpoint =
          tab === "schedule"
            ? "sources"
            : tab === "articles"
              ? "articles"
              : "requests";
        const [summary, list] = await Promise.all([
          json("/api/overview", signal),
          json(`/api/${endpoint}?${params}`, signal),
        ]);
        setOverview(summary);
        setRows(list.items);
        setNextCursor(list.nextCursor || null);
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
  const filteredSites = (overview?.sites || []).filter(
    (s: Row) => !domain || s.domain === domain,
  );
  const running = overview?.running;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="wordmark"
          href="?view=overview"
          aria-label="Crawler observatory home"
        >
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
            News discovery<span>Work trial / v1.0</span>
          </div>
          <ChevronRight size={14} />
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {tabs.map((t) => (
            <button
              key={t.id}
              className={`nav-item ${tab === t.id ? "active" : ""}`}
              onClick={() => changeTab(t.id)}
            >
              <t.icon size={17} />
              {t.label}
              {t.id === "articles" && totals && (
                <span className="nav-count">{number(totals.fresh)}</span>
              )}
            </button>
          ))}
          <a className="nav-item" href="/charts"><BarChart3 size={17}/>Charts</a>
        <a className="nav-item" href="/reconciliation"><ScanSearch size={17}/>Coverage</a><a className="nav-item" href="/freshness"><Clock3 size={17}/>Freshness</a></nav>
        <div className="sidebar-note">
          <Radio size={17} />
          <strong>A window into the crawl.</strong>
          <p>
            Every request. Every discovery.
            <br />
            One place to follow it all.
          </p>
        </div>
        <div className="sidebar-bottom">
          <div className="deployment">
            <span className={`dot ${running ? "green" : "amber"}`} />
            <div>
              {running
                ? "Collector online"
                : overview
                  ? "Heartbeat stale"
                  : "Checking collector"}
              <span>Google Cloud · us-central1</span>
            </div>
          </div>
          <a
            href="https://github.com/saripovdenis/crawler-work-trial"
            target="_blank"
            rel="noreferrer"
          >
            <GitBranch size={16} />
            View source
            <ArrowUpRight size={14} />
          </a>
          <span className="trial-note">Independent work trial</span>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div className="breadcrumb">
            Workspace
            <ChevronRight size={13} />
            <strong>
              {tabs.find((t) => t.id === tab)?.label || "Overview"}
            </strong>
          </div>
          <div className="topbar-right">
            <span className="read-only">
              <Globe2 size={13} />
              Public, read-only
            </span>
            <a
              className="api-link"
              href="/api/overview"
              target="_blank"
              rel="noreferrer"
            >
              <Code2 size={15} />
              API
              <ArrowUpRight size={13} />
            </a>
            <span className="avatar">DS</span>
          </div>
        </header>
        <div className="content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                <span className="tiny-grid" /> CRAWLER INTELLIGENCE
              </div>
              <h1>
                {tab === "overview"
                  ? "The web, as it happens."
                  : tab === "requests"
                    ? "Every request, in view."
                    : tab === "articles"
                      ? "Fresh from the web."
                      : "What happens next."}
              </h1>
              <p>
                {tab === "overview"
                  ? "Live discoveries and the system behind them."
                  : tab === "requests"
                    ? "Inspect responses, timing, and the links each poll returned."
                    : tab === "articles"
                      ? "Browse discovered articles and their publication evidence."
                      : "Source eligibility and the requests waiting in line."}
              </p>
            </div>
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
              <ListFilter size={15} />
              <select
                aria-label="Filter by website"
                value={domain}
                onChange={(e) => selectDomain(e.target.value)}
              >
                <option value="">All 20 websites</option>
                {overview?.sites.map((s: Row) => (
                  <option key={s.domain} value={s.domain}>
                    {s.domain}
                  </option>
                ))}
              </select>
              {domain && (
                <button
                  className="clear-filter"
                  aria-label="Clear website filter"
                  onClick={() => selectDomain("")}
                >
                  <X size={13} />
                </button>
              )}
              <span className="filter-separator" />
              <span className="collection-start">
                Collecting since{" "}
                {overview
                  ? new Date(overview.startedAt).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })
                  : "—"}
              </span>
            </div>
            <span className="updated">
              <span className={`dot ${live ? "green" : "gray"}`} />
              {overview
                ? `Updated ${time(overview.generatedAt)}`
                : "Connecting…"}
              <span className="timezone">local time</span>
            </span>
          </div>
          {tab === "overview" && (
            <>
              {domain && (
                <p className="scope-note">
                  Summary metrics and chart show all websites. Tables are
                  filtered to {domain}.
                </p>
              )}
              <section
                className="metrics"
                aria-label="All-time crawler metrics"
              >
                <div className="metric">
                  <span>
                    Fresh articles
                    <FileText size={16} />
                  </span>
                  <strong>{number(totals?.fresh)}</strong>
                  <small>
                    <span className="blue">Published during collection</span>
                    <span>All time</span>
                  </small>
                </div>
                <div className="metric">
                  <span>
                    Websites responding
                    <Globe2 size={16} />
                  </span>
                  <strong>
                    {number(totals?.respondingSites)}
                    <em>/20</em>
                  </strong>
                  <small>At least one successful source</small>
                </div>
                <div className="metric">
                  <span>
                    Median discovery delay
                    <Clock3 size={16} />
                  </span>
                  <strong>{delay(totals?.p50Delay ?? null)}</strong>
                  <small>
                    From publisher timestamps · {number(totals?.delaySamples)}{" "}
                    samples
                  </small>
                </div>
                <div className="metric">
                  <span>
                    Total requests
                    <Activity size={16} />
                  </span>
                  <strong>{number(totals?.requests)}</strong>
                  <small>
                    <span>{number(totals?.errors)} failed attempts</span>
                    <span>All time</span>
                  </small>
                </div>
              </section>
              <section className="panel chart-panel">
                <div className="panel-header">
                  <div>
                    <h2>Discovery activity</h2>
                    <p>Request volume and fresh articles over the last hour</p>
                  </div>
                  <span className="period">
                    <Clock3 size={13} />
                    Last 60 minutes
                  </span>
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
                  <small>5-minute intervals</small>
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
                        tickFormatter={(n) =>
                          new Date(n).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                            hour12: false,
                          })
                        }
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
                  <div className="title-inline">
                    <h2>Website health</h2>
                    <Badge variant="outline">
                      {filteredSites.length} sources
                    </Badge>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => changeTab("schedule")}
                  >
                    View schedule
                    <ArrowRight size={14} />
                  </Button>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Website</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Fresh articles</TableHead>
                      <TableHead>Request budget / min</TableHead>
                      <TableHead>Next poll eligible</TableHead>
                      <TableHead className="text-right">Last request</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredSites.map((s: Row) => (
                      <TableRow key={s.domain}>
                        <TableCell>
                          <button
                            className="site-link"
                            onClick={() => {
                              selectDomain(s.domain);
                              changeTab("requests");
                            }}
                          >
                            <Domain name={s.domain} />
                          </button>
                        </TableCell>
                        <TableCell>
                          <Health state={s.health} />
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
              <section className="panel recent-panel">
                <div className="panel-header">
                  <div className="title-inline">
                    <h2>Latest requests</h2>
                    <span className="live-label">
                      <span className="dot green" />
                      Live
                    </span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => changeTab("requests")}
                  >
                    Open request log
                    <ArrowRight size={14} />
                  </Button>
                </div>
                {rows.slice(0, 5).map((row) => (
                  <button
                    key={row.id}
                    className="recent-row"
                    onClick={() => inspect(row)}
                  >
                    <span className="numeric muted">{time(row.started)}</span>
                    <Domain name={row.domain} />
                    <span className="request-path">
                      {row.url.replace(/^https?:\/\/[^/]+/, "")}
                    </span>
                    <Status row={row} />
                    <ChevronRight size={14} />
                  </button>
                ))}
              </section>
            </>
          )}
          {tab === "requests" && (
            <section className="panel">
              <div className="panel-header">
                <div>
                  <h2>Request log</h2>
                  <p>Each HTTP attempt, including redirects and retries</p>
                </div>
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
                    <TableHead>Time</TableHead>
                    <TableHead>Website / URL</TableHead>
                    <TableHead>Purpose</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Duration</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="numeric muted">
                        {time(r.started)}
                      </TableCell>
                      <TableCell>
                        <Domain name={r.domain} />
                        <span className="row-url">{r.url}</span>
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
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => inspect(r)}
                          aria-label={`Inspect request ${r.id}`}
                        >
                          <ArrowUpRight size={16} />
                        </Button>
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
              <div className="panel-header article-tools">
                <div>
                  <h2>Discovered articles</h2>
                  <p>Publication times come from the publisher</p>
                </div>
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
                    <h3 dir="auto">{r.title || "Untitled article"}</h3>
                    <p dir="auto">
                      {r.description || "No description available"}
                    </p>
                  </div>
                  <ArrowUpRight size={17} />
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
                <Badge variant="outline">{rows.length} endpoints</Badge>
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
                        <Domain name={r.domain} />
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
                        <span
                          className={r.errors ? "error-text" : "muted"}
                          title={r.lastError || ""}
                        >
                          {r.errors
                            ? `${r.errors} consecutive failures`
                            : "Ready"}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </section>
          )}
          <footer className="page-footer">
            <span>
              <Database size={13} />
              Live collector data · refreshes every 10s
            </span>
            <span>
              Coverage not yet measured
              <CircleHelp size={13} />
            </span>
          </footer>
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
            <div className="eyebrow">
              {detail?.type === "article"
                ? "ARTICLE DETAILS"
                : "REQUEST INSPECTOR"}
            </div>
            <SheetTitle>
              {detail?.type === "article"
                ? "A closer look."
                : `Request #${detail?.id || ""}`}
            </SheetTitle>
            <SheetDescription>
              {detail?.type === "article"
                ? "Metadata saved by the collector."
                : "The actual saved outcome of this HTTP attempt."}
            </SheetDescription>
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
                  <div className="detail-section">
                    <h3>
                      Links in this response{" "}
                      <Badge variant="outline">{detail.linkCount ?? "—"}</Badge>
                    </h3>
                    <p>
                      Reconstructed from the saved response using the current
                      parser. Links are candidates, not necessarily new
                      articles.
                    </p>
                    {detailLoading ? (
                      <div className="empty-state">Loading saved response…</div>
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
                            : detail.purpose !== "discovery"
                              ? "Link inspection applies to discovery polls."
                              : "No candidate links in this response.")}
                      </div>
                    )}
                    {detail.linkCount > 200 && (
                      <p>Showing the first 200 candidate links.</p>
                    )}
                  </div>
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
      <span>Try another website or filter.</span>
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
      <span>Up to 60 results per page</span>
      <div>
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
    </div>
  );
}
