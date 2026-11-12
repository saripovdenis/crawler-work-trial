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
    comparison: timingComparison(groups, providers),
    providers: providers.map(provider => ({ provider, ...freshnessSummary(groups, provider) })),
    domains: domains.map(site => ({ site, ...freshnessSummary(groups.filter(g => g.site === site)) })),
  };
}

/** A paired comparison: every series uses the same articles and publication clock. */
export function timingComparison(groups: Group[], providers: readonly string[]) {
  const ids = [...new Set(providers)];
  const values = new Map<string, number[]>(['crawler', ...ids].map(id => [id, []]));
  const excluded = { missingFetch: 0, missingProviderObservation: 0, missingPublication: 0 };
  let count = 0, incomplete = 0, probable = 0, differingPublicationDates = 0, negativeTiming = 0;
  for (const group of groups) {
    if (!group.match || group.crawler_fetch_finished_at === null || !Number.isFinite(group.crawler_fetch_finished_at)) {
      excluded.missingFetch++;
      continue;
    }
    const timings = group.provider_timings.filter(t => ids.includes(t.provider));
    const observations = ids.map(id => {
      const times = timings.filter(t => t.provider === id).map(t => t.observed_at).filter(Number.isFinite);
      return times.length ? Math.min(...times) : null;
    });
    if (!ids.length || observations.some(t => t === null)) {
      excluded.missingProviderObservation++;
      continue;
    }
    const publications = timings.flatMap(t => t.published_at !== null && Number.isFinite(t.published_at) ? [t.published_at] : []);
    if (!publications.length) { excluded.missingPublication++; continue; }
    const published = Math.min(...publications);
    const delays = [group.crawler_fetch_finished_at - published, ...observations.map(t => t! - published)];
    ['crawler', ...ids].forEach((id, index) => values.get(id)!.push(delays[index]));
    count++;
    if (group.incomplete) incomplete++;
    if (group.match === 'title') probable++;
    if (Math.max(...publications) !== published) differingPublicationDates++;
    if (delays.some(delay => delay < 0)) negativeTiming++;
  }
  return {
    count, total: groups.length, excluded, incomplete, probable, differingPublicationDates, negativeTiming,
    baseline: 'earliest_selected_provider_publication',
    series: [...values].map(([id, delays]) => ({ id, ...percentiles(delays) })),
  };
}
