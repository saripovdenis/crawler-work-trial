import { useEffect, useState } from "react";
import { ProviderSelect } from "@/components/ProviderSelect";
import { comparisonProviders, selectedComparisonProvider } from "../../../../../config/comparison";
import { PageHead, Shell } from "@/components/Shell";

type StatusCounts = { total: number; compared: number; crawlerOnly: number; percentage: number | null };
type CrawlerOnlySnapshot = {
  generatedAt: number; gracePeriodMinutes: number; provisional: boolean; summary: StatusCounts;
  domains: (StatusCounts & { site: string })[];
};

const windows = ["1h", "24h", "7d"];
const number = (value: number) => value.toLocaleString("en-US");
const percent = (value: number | null | undefined) => value == null ? "—" : `${value.toFixed(1)}%`;
const ratio = (value: StatusCounts) => `${number(value.crawlerOnly)} / ${number(value.compared)}`;

export default function CrawlerOnlyPage() {
  const [window, setWindow] = useState(() => {
    const value = new URLSearchParams(location.search).get("window") || "24h";
    return windows.includes(value) ? value : "24h";
  });
  const [provider, setProvider] = useState(() => selectedComparisonProvider(new URLSearchParams(location.search).get("provider")));
  const [data, setData] = useState<CrawlerOnlySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    history.replaceState(null, "", "/crawler-only?" + new URLSearchParams({ window, provider }));
    const controller = new AbortController();
    let running = false;
    setData(null);
    setError("");
    async function load() {
      if (running || controller.signal.aborted) return;
      running = true;
      setLoading(true);
      try {
        const params = new URLSearchParams({ window, provider });
        const response = await fetch("/api/crawler-only?" + params, {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]),
        });
        if (!response.ok) throw new Error(`Could not load comparison (HTTP ${response.status}).`);
        const result: CrawlerOnlySnapshot = await response.json();
        if (!controller.signal.aborted) { setData(result); setError(""); setNow(Date.now()); }
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error && failure.name === "TimeoutError"
          ? "Comparison took too long. Try again." : failure instanceof Error ? failure.message : "Could not load comparison.");
      } finally {
        running = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    // Always make the first request; pause only background refreshes when hidden.
    void load();
    const visibleLoad = () => { if (!document.hidden) void load(); };
    const timer = setInterval(visibleLoad, 30000);
    document.addEventListener("visibilitychange", visibleLoad);
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", visibleLoad); };
  }, [window, provider, refresh]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(timer);
  }, []);

  const expired = data && now - data.generatedAt >= 300000;
  const current = expired ? null : data;
  const domains = [...(current?.domains || [])].sort((a, b) =>
    (b.percentage ?? -1) - (a.percentage ?? -1) || a.site.localeCompare(b.site));

  return <Shell active="crawler-only">
    <PageHead title="Crawler-only">
      <ProviderSelect value={provider} onChange={setProvider} />
      <select aria-label="Publication window" value={window} onChange={event => setWindow(event.target.value)}>
        <option value="1h">Last hour · provisional</option><option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option>
      </select>
    </PageHead>
    {(error || expired) && <div className="alerts" role="alert"><p>
      {error || "Comparison is out of date."} <button className="link" disabled={loading} onClick={() => setRefresh(value => value + 1)}>Retry</button>
    </p></div>}
    <section className="stats stats-1" aria-label="Overall crawler-only percentage" aria-busy={loading}>
      <div className="stat">
        <span className="label">Not in the {comparisonProviders[provider]} sample</span>
        <strong>{percent(current?.summary.percentage)}</strong>
        <small>{current ? `${ratio(current.summary)} compared articles` : loading ? "Loading…" : "No comparison available"}</small>
      </div>
    </section>
    {current && <>
      <table className="tbl">
        <caption className="sr-only">Crawler-only percentage by domain</caption>
        <thead><tr><th>Domain</th><th className="num">Crawler-only</th><th className="num">Articles</th></tr></thead>
        <tbody>{domains.map(domain => <tr key={domain.site}>
          <td>{domain.site}</td>
          <td className="num">{percent(domain.percentage)}</td>
          <td className="num faint" title={`${number(domain.total - domain.compared)} excluded: recent, uncertain, or without comparison evidence.`}>
            {domain.compared ? ratio(domain) : domain.total ? "No comparison" : "No posts"}
          </td>
        </tr>)}</tbody>
      </table>
      <p className="footnote">
        {current.provisional ? "Live comparison: Google may list these articles later." : `Articles ≥${current.gracePeriodMinutes} min old.`} Uncertain matches and missing comparison evidence are excluded. Absence from a sample does not prove absence from Google.
        {" "}Updated {new Date(current.generatedAt).toISOString().slice(11, 19)} UTC{loading ? " · refreshing" : ""}.
      </p>
    </>}
  </Shell>;
}
