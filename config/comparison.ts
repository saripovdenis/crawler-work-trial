// Providers offered by the dashboard and scheduled for new comparisons.
// Historical provider records stay in storage when an entry is removed here.
export const comparisonProviders: Record<string, string> = { google: "Google News", exa: "Exa" };
export const defaultComparisonProvider = "google";
export function selectedComparisonProvider(value: string | null) {
  return value && Object.hasOwn(comparisonProviders, value) ? value : defaultComparisonProvider;
}
