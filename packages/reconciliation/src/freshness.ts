import type { Group } from "./view.js";

// Nearest-rank percentiles: an observed value, including for small samples.
export function percentiles(values: number[]) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const at = (p: number) => sorted.length ? sorted[Math.ceil(p * sorted.length) - 1] : null;
  return { count: sorted.length, p50: at(.5), p75: at(.75), p90: at(.9) };
}

export function freshnessSummary(groups: Group[], provider?: string) {
  const selected = provider ? groups.filter(g => g.providers.includes(provider)) : groups;
  const observed: number[] = [], published: number[] = [];
  let timed = 0, incomplete = 0, probable = 0;
  for (const group of selected) {
    if (!group.match || group.crawler_fetch_finished_at === null) continue;
    const timings = group.provider_timings.filter(t => !provider || t.provider === provider);
    const observations = timings.map(t => t.observed_at).filter(Number.isFinite);
    const publications = timings.flatMap(t => t.published_at === null ? [] : [t.published_at]).filter(Number.isFinite);
    if (!observations.length) continue;
    timed++;
    if (group.incomplete) incomplete++;
    if (group.match === "title") probable++;
    observed.push(group.crawler_fetch_finished_at - Math.min(...observations));
    if (publications.length) published.push(group.crawler_fetch_finished_at - Math.min(...publications));
  }
  const matched = selected.filter(g => g.match).length;
  return {
    total: selected.length, matched, timed, unmatched: selected.length - matched,
    missingTiming: matched - timed, incomplete, probable,
    observed: percentiles(observed), published: percentiles(published),
  };
}

export function summarizeFreshness(groups: Group[], domains: readonly string[], providers: readonly string[]) {
  return {
    overall: freshnessSummary(groups),
    providers: providers.map(provider => ({ provider, ...freshnessSummary(groups, provider) })),
    domains: domains.map(site => ({ site, ...freshnessSummary(groups.filter(g => g.site === site)) })),
  };
}
