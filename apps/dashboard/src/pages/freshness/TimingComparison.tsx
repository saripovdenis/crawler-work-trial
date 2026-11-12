import { CartesianGrid, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from "recharts";

type Series = { id: string; count: number; p50: number | null; p75: number | null; p90: number | null };
type Comparison = {
  count: number; total: number; incomplete: number; probable: number; differingPublicationDates: number; negativeTiming: number;
  excluded: { missingFetch: number; missingProviderObservation: number; missingPublication: number };
  series: Series[];
};
const styles: Record<string, { name: string; detail: string; color: string; shape: "circle" | "square" | "diamond" }> = {
  crawler: { name: "Your crawler", detail: "Download finished", color: "#1840ed", shape: "circle" },
  google: { name: "Google News", detail: "First seen by our poll", color: "#ad6508", shape: "square" },
  exa: { name: "Exa", detail: "First seen by our poll", color: "#8c40b8", shape: "diamond" },
};
const keys = ["p50", "p75", "p90"] as const;
const elapsed = (value: number | null | undefined) => {
  if (value == null) return "—";
  const minutes = Math.abs(value) / 60000;
  const text = minutes < 1 ? `${Math.round(minutes * 60)}s` : minutes < 60 ? `${minutes.toFixed(1)} min` : `${(minutes / 60).toFixed(1)} h`;
  return value < 0 ? `−${text}` : text;
};
export default function TimingComparison({ data, loading, cadence }: { data?: Comparison; loading: boolean; cadence: number }) {
  const series = data?.series || [];
  return <section className="reconcile-panel timing-comparison" aria-label="Crawler and provider timing comparison" aria-busy={loading}>
    <div className="panel-heading"><div>
      <span className="comparison-eyebrow">SAME ARTICLES · SAME PUBLICATION CLOCK</span>
      <h2>Your crawler vs Google News vs Exa</h2>
      <p>Time after publication. Farther left means earlier.</p>
    </div><span className="comparison-count">{data?.count ?? "—"} shared articles</span></div>
    <div className="comparison-legend">{series.map(s => <div key={s.id}>
      <i className={`comparison-symbol ${styles[s.id].shape}`} style={{ background: styles[s.id].color }} />
      <span><strong>{styles[s.id].name}</strong><small>{styles[s.id].detail}</small></span>
    </div>)}</div>
    <div className="comparison-chart">
      {data?.count ? <ResponsiveContainer width="100%" height="100%">
        <ScatterChart margin={{ top: 8, right: 28, bottom: 12, left: 0 }} accessibilityLayer>
          <CartesianGrid stroke="#e8ecf4" strokeDasharray="3 4" />
          <XAxis type="number" dataKey="delay" domain={[(min: number) => Math.min(0, min), "auto"]} tickFormatter={elapsed} tickLine={false} axisLine={false} tick={{ fontSize: 11 }} />
          <YAxis type="number" dataKey="row" domain={[-0.5, 2.5]} ticks={[0, 1, 2]} tickFormatter={row => ["P90", "P75", "P50"][row] || ""} tickLine={false} axisLine={false} width={48} tick={{ fontSize: 12, fontWeight: 600 }} />
          <ReferenceLine x={0} stroke="#a9b1c0" />
          <Tooltip cursor={false} content={({ active, payload }) => {
            const point = payload?.[0]?.payload;
            return active && point ? <div className="comparison-tooltip"><strong>{point.name} · {point.percentile}</strong><span>{elapsed(point.delay)} after publication</span><small>{point.count} shared articles · {point.detail}</small></div> : null;
          }} />
          {series.map((s, index) => <Scatter key={s.id} name={styles[s.id].name} fill={styles[s.id].color} shape={styles[s.id].shape} isAnimationActive={false}
            data={keys.flatMap((key, row) => s[key] == null ? [] : [{ delay: s[key], row: 2 - row + (index - (series.length - 1) / 2) * .16, name: styles[s.id].name, detail: styles[s.id].detail, percentile: key.toUpperCase(), count: s.count }])} />)}
        </ScatterChart>
      </ResponsiveContainer> : <div className="reconcile-empty">{loading ? "Loading the shared sample…" : "No shared timed articles in this window. Try a longer window or compare with one provider."}</div>}
    </div>
    <div className="comparison-axis-note">Time since article publication</div>
    <div className="reconcile-table"><table>
      <caption className="sr-only">Timing comparison on the same articles; all values are elapsed time after publication</caption>
      <thead><tr><th>Percentile</th>{series.map(s => <th key={s.id}>{styles[s.id].name}</th>)}</tr></thead>
      <tbody>{keys.map(key => <tr key={key}><th scope="row">{key.toUpperCase()}<small>{key === "p50" ? "Half the articles" : key === "p75" ? "75% of articles" : "90% of articles"}</small></th>{series.map(s => <td key={s.id}>{elapsed(s[key])}</td>)}</tr>)}</tbody>
    </table></div>
    <p className="comparison-note"><strong>What is measured:</strong> your successful download finish, versus when our poll first saw the article in Google News or Exa. Their actual indexing times are unknown. Polls run every {cadence} minutes, so provider observation can lag availability.</p>
    <details className="comparison-method"><summary>Sample and calculation details</summary>
      <p>For each article, subtract the earliest publication date reported by the selected providers from all three timestamps. Each series uses exactly the same articles. P50/P75/P90 are the 50th/75th/90th percentiles of those elapsed times, not differences between separate medians.</p>
      <p>{data?.count ?? 0} shared timed articles out of {data?.total ?? 0} external articles. Excluded: {data?.excluded.missingFetch ?? 0} without a matched download, {data?.excluded.missingProviderObservation ?? 0} without all selected provider observations, {data?.excluded.missingPublication ?? 0} without publication time. These exclusions do not count as fast results.</p>
      <p>Included: {data?.probable ?? 0} probable title matches; {data?.incomplete ?? 0} incomplete parses; {data?.differingPublicationDates ?? 0} articles with differing reported publication dates. This compares a shared sample, not total coverage.</p>
    </details>
    {data && data.count > 0 && data.count < 5 && <p className="comparison-note">Small sample: fewer than five shared articles. Percentiles may coincide.</p>}
    {!!data?.negativeTiming && <p className="comparison-note">{data.negativeTiming} articles have a timestamp before reported publication. Negative values are retained; inspect the source timestamps.</p>}
  </section>;
}
