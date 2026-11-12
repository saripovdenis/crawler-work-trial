import { domainFor } from "../../core/src/policy.js";
export function urlKey(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (!domainFor(u.href)) return null;
    u.hash = "";
    for (const k of [...u.searchParams.keys()])
      if (/^(utm_|fbclid$|gclid$)/i.test(k)) u.searchParams.delete(k);
    u.searchParams.sort();
    return (
      u.hostname.replace(/^www\./, "") +
      u.pathname.replace(/\/$/, "") +
      (u.search || "")
    );
  } catch {
    return null;
  }
}
export function titleKey(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
export function date(value: unknown): number | null {
  if (
    typeof value !== "string" ||
    !/(?:Z|[+-]\d\d:?\d\d|GMT|UTC)\s*$/i.test(value)
  )
    return null;
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : null;
}
export type Sighting = {
  url_raw: string;
  url_key: string | null;
  title: string;
  title_key: string;
  provider_published_at: number | null;
  provider_first_seen_at: number | null;
};
export function sighting(
  site: string,
  url: string,
  title: string,
  published: number | null,
  seen: number | null = null,
): Sighting | null {
  if (domainFor(url) !== site) return null;
  return {
    url_raw: url,
    url_key: urlKey(url),
    title,
    title_key: titleKey(title),
    provider_published_at: published,
    provider_first_seen_at: seen,
  };
}
