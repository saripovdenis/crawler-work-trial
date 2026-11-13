import { useEffect, useState } from "react";
import { Alerts, PageHead, Shell } from "@/components/Shell";
import { ProviderSelect } from "@/components/ProviderSelect";
import { Updated } from "@/components/Updated";
import { comparisonProviders, selectedComparisonProvider } from "../../../../../config/comparison";

type Stats = {
  total: number;
  matched: number;
  coverage: number | null;
  freshness: { count: number; p50: number | null; p90: number | null };
};
type Summary = {
  generatedAt: number;
  ready: boolean;
  heartbeat: number | null;
  truncated: boolean;
  dispatchFailures: number;
  providerState: { enabled: boolean; quotaExhausted: boolean; lastError: string | null; note: string | null } | null;
  windows: (Stats & { window: string; domains: (Stats & { site: string })[] })[];
  cache?: { staleLimitMs?: number };
};
type Kind = "coverage" | "freshness";

const labels: Record<string, string> = { "10m": "10 min", "1h": "1 hour", "24h": "24 hours" };
const number = (v: number) => v.toLocaleString("en-US");
const duration = (ms: number | null) => {
  if (ms == null) return "—";
  const s = Math.abs(ms) / 1000;
  const text = s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${(s / 60).toFixed(1)}m` : `${(s / 3600).toFixed(1)}h`;
  return (ms < 0 ? "−" : "") + text;
};
// Each page reads one figure from the same per-window stats.
const views = {
  coverage: {
    title: "Coverage",
    value: (s: Stats, digits = 1) => (s.coverage == null ? "—" : `${s.coverage.toFixed(digits)}%`),
    note: (s: Stats) => (s.total ? `${number(s.matched)} / ${number(s.total)}` : ""),
  },
  freshness: {
    title: "Freshness",
    value: (s: Stats) => duration(s.freshness.p50),
    note: (s: Stats) => (s.freshness.count ? `p90 ${duration(s.freshness.p90)} · n ${number(s.freshness.count)}` : ""),
  },
};

export default function SummaryPage({ kind }: { kind: Kind }) {
  const [provider, setProvider] = useState(() => selectedComparisonProvider(new URLSearchParams(location.search).get("provider")));
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const params = new URLSearchParams({ provider });
    history.replaceState(null, "", location.pathname + (Object.keys(comparisonProviders).length > 1 ? "?" + params : ""));
    const controller = new AbortController();
    let running = false;
    async function load() {
      if (document.hidden || running) return;
      running = true;
      try {
        const r = await fetch("/api/summary?" + params, { signal: controller.signal });
        if (!r.ok) throw new Error(`Data service returned ${r.status}.`);
        setData(await r.json());
        setError("");
      } catch (e) {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      } finally {
        running = false;
      }
    }
    void load();
    const timer = setInterval(load, 30000);
    document.addEventListener("visibilitychange", load);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [provider]);

  const view = views[kind];
  const name = comparisonProviders[provider];
  const p = data?.providerState;
  const windows: ({ window: string } & Partial<Stats>)[] = data?.windows ?? ["10m", "1h", "24h"].map((window) => ({ window }));
  const sites = data?.windows[0]?.domains.map((d) => d.site) ?? [];
  return (
    <Shell active={kind}>
      <PageHead title={view.title}>
        <ProviderSelect value={provider} onChange={setProvider} />
        <Updated at={data?.generatedAt} staleLimitMs={data?.cache?.staleLimitMs} />
      </PageHead>
      <Alerts
        items={[
          error && `${error}${data ? " Showing the last result." : ""}`,
          data && !data.ready && "Waiting for the first provider poll.",
          !!data?.heartbeat && data.generatedAt - data.heartbeat > 90000 && "Reconciler heartbeat is stale.",
          p?.quotaExhausted && `${name} quota reached.`,
          p && !p.enabled && (p.note || `${name} polls are paused.`),
          p?.lastError && `${name}: ${p.lastError}`,
          data?.truncated && "A provider result limit was reached; the sample is truncated.",
          kind === "coverage" && !!data?.dispatchFailures && `${number(data.dispatchFailures)} dispatch deadline failures in the last hour.`,
        ]}
      />
      <section className="stats stats-3" aria-busy={!data}>
        {windows.map((w) => (
          <div className="stat" key={w.window}>
            <span className="label">{labels[w.window]}</span>
            <strong>{data ? view.value(w as Stats) : "—"}</strong>
            <small>{data ? view.note(w as Stats) || "No sample" : "\u00a0"}</small>
          </div>
        ))}
      </section>
      {data && (
        <table className="tbl split">
          <thead>
            <tr>
              <th>Domain</th>
              {data.windows.map((w) => <th key={w.window} className="num">{w.window}</th>)}
            </tr>
          </thead>
          <tbody>
            {sites.map((site, i) => (
              <tr key={site}>
                <td>{site}</td>
                {data.windows.map((w) => {
                  const s = w.domains[i]!;
                  const value = kind === "coverage" ? views.coverage.value(s, 0) : view.value(s);
                  return (
                    <td key={w.window} className="num">
                      <span className={value === "—" ? "faint" : undefined}>{value}</span>
                      <span className="n">
                        {kind === "coverage" ? (s.total ? `${s.matched}/${s.total}` : "") : s.freshness.count || ""}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Shell>
  );
}
