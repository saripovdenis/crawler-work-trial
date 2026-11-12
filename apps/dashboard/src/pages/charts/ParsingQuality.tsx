import { useEffect, useState } from 'react';
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Button } from '@/components/ui/button';

const windows = [['5m','5 min'],['30m','30 min'],['1h','1 h'],['3h','3 h'],['1d','Day'],['1w','Week']] as const;
type Window = typeof windows[number][0];
type Counts = { total: number; incomplete: number; percentage: number | null };
type Domain = Counts & { domain: string };
type Data = { window: Window; windowStart: string; windowEnd: string; overall: Counts; domains: Domain[] };
const percent = (n: number | null) => n === null ? '—' : `${n.toFixed(1)}%`;
const initialWindow = (): Window => {
  const value = new URLSearchParams(location.search).get('window');
  return windows.some(([key]) => key === value) ? value as Window : '1h';
};
function QualityTooltip({ active, payload }: { active?: boolean; payload?: readonly { payload?: Domain }[] }) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  return <div className="quality-tooltip"><strong>{row.domain}</strong><p>{row.total ? `${percent(row.percentage)} incomplete` : 'No articles'}</p><span>{row.incomplete} incomplete / {row.total} total</span></div>;
}
export function ParsingQuality() {
  const [window, setWindow] = useState<Window>(initialWindow);
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const url = new URL(location.href); url.searchParams.set('window', window); history.replaceState(null, '', url);
  }, [window]);
  useEffect(() => {
    const back = () => setWindow(initialWindow());
    globalThis.addEventListener('popstate', back);
    return () => globalThis.removeEventListener('popstate', back);
  }, []);
  useEffect(() => {
    let disposed = false;
    let active: AbortController | undefined;
    async function refresh() {
      if (document.hidden || active) return;
      const control = new AbortController(); active = control;
      setLoading(true);
      try {
        const response = await fetch(`/api/charts/parsing-quality?window=${window}`, { signal: control.signal });
        if (!response.ok) throw new Error('Parsing quality is temporarily unavailable.');
        const next: Data = await response.json();
        if (!disposed) { setData(next); setError(''); }
      } catch (e) {
        if (!disposed && !control.signal.aborted) setError(e instanceof Error ? e.message : 'Unable to load chart.');
      } finally { active = undefined; if (!disposed) setLoading(false); }
    }
    void refresh();
    const timer = globalThis.setInterval(() => void refresh(), 30_000);
    const visibility = () => { if (document.hidden) active?.abort(); else void refresh(); };
    document.addEventListener('visibilitychange', visibility);
    return () => { disposed = true; active?.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [window, retry]);
  const updating = loading || data?.window !== window;
  const rows = data?.domains.map(row => ({ ...row, value: row.percentage ?? 0, countLabel: row.total ? `${row.incomplete} / ${row.total}` : 'no articles' })) ?? [];
  return <section className="quality-card" aria-labelledby="quality-title" aria-busy={loading}>
    <div className="quality-header"><div><h2 id="quality-title">Parsing quality</h2><p>Incomplete articles · by domain</p></div></div>
    <div className="quality-summary"><strong>{percent(data?.overall.percentage ?? null)}</strong><span>{data ? `${data.overall.incomplete.toLocaleString('en-US')} / ${data.overall.total.toLocaleString('en-US')}` : '— / —'}<small>incomplete / total · all domains</small></span></div>
    <div className="quality-controls" role="group" aria-label="Time window">{windows.map(([key, label]) => <Button key={key} size="sm" variant={window === key ? 'default' : 'ghost'} aria-pressed={window === key} onClick={() => setWindow(key)}>{label}</Button>)}</div>
    <div className="quality-message" aria-live="polite">{error ? <><span role="alert">{error}</span><button onClick={() => setRetry(n => n + 1)}>Retry</button></> : updating ? (data ? 'Updating · showing previous result' : 'Loading parsing quality…') : data?.overall.total === 0 ? 'No parsed articles in this window.' : <span><i/>Fewer than 5 articles</span>}</div>
    {data ? <div className="quality-plot"><ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 0, bottom: 0, left: 0 }} accessibilityLayer>
          <XAxis type="number" domain={[0,100]} ticks={[0,50,100]} tickFormatter={v => `${v}%`} tick={{ fontSize: 10, fill: '#8b8e9c' }} axisLine={false} tickLine={false} orientation="top"/>
          <YAxis type="category" dataKey="domain" width={139} tick={{ fontSize: 10, fill: '#626778' }} axisLine={false} tickLine={false} interval={0}/>
          <YAxis yAxisId="counts" type="category" dataKey="countLabel" orientation="right" width={64} tick={({ x, y, payload }) => <text x={x} y={y} dy={3} textAnchor="start" fontSize={10} fill="#626778">{payload.value}</text>} axisLine={false} tickLine={false} interval={0}/>
          <Tooltip content={<QualityTooltip/>} cursor={{ fill: '#f4f6fc' }} isAnimationActive={false}/>
          <Bar dataKey="value" barSize={10} radius={[0,3,3,0]} isAnimationActive={false} background={{ fill: '#f4f5f9', radius: 3 }}>
            {rows.map(row => <Cell key={row.domain} fill={row.total < 5 ? '#c6cffb' : '#1840ed'}/>)}
          </Bar>
        </BarChart>
      </ResponsiveContainer></div> : <div className="quality-placeholder">{error ? 'Chart unavailable' : 'Loading…'}</div>}
  </section>;
}
