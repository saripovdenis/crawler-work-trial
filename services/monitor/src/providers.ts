import { XMLParser } from "fast-xml-parser";
import { editions, type ProviderId } from "../../../config/monitor.js";
import {
  date,
  sighting,
  titleKey,
  type Sighting,
} from "../../../packages/reconciliation/src/identity.js";
import { domainFor } from "../../../packages/core/src/policy.js";
import { providerRequest } from "./client.js";
export type Batch = {
  items: Sighting[];
  rawCount: number;
  truncated: boolean;
  providerCost: number | null;
};
export function parseResults(
  id: ProviderId,
  site: string,
  body: string,
): Batch {
  const items: Sighting[] = [];
  let rawCount = 0,
    truncated = false,
    providerCost: number | null = null;
  if (id === "google") {
    const parsed = new XMLParser({
      ignoreAttributes: false,
      processEntities: true,
    }).parse(body);
    if (!parsed.rss?.channel) throw new Error("Invalid RSS response");
    const rows = parsed.rss.channel.item;
    const records = rows ? (Array.isArray(rows) ? rows : [rows]) : [];
    rawCount = records.length;
    truncated = rawCount >= 100;
    for (const row of records) {
      const source = row.source?.["@_url"];
      if (typeof source !== "string" || domainFor(source) !== site) continue;
      let sourceHost: string | null = null;
      try { sourceHost = new URL(source).hostname.toLowerCase(); } catch { /* keep the row without a host */ }
      const label = String(row.source?.["#text"] || "");
      let title = String(row.title || "");
      if (label && title.endsWith(" - " + label))
        title = title.slice(0, -label.length - 3);
      const url = String(row.link || "");
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        continue;
      }
      if (u.protocol !== "https:" || u.hostname !== "news.google.com") continue;
      items.push({
        url_raw: url,
        url_key: null,
        title,
        title_key: titleKey(title),
        provider_published_at: date(row.pubDate),
        provider_first_seen_at: null,
        source_host: sourceHost,
      });
    }
  } else {
    const data = JSON.parse(body);
    const records = data.results;
    providerCost =
      typeof data.costDollars?.total === "number"
        ? data.costDollars.total
        : null;
    if (!Array.isArray(records)) throw new Error("Invalid provider response");
    rawCount = records.length;
    truncated = rawCount >= 10;
    for (const row of records) {
      const item = sighting(
        site,
        String(row.url || row.link || ""),
        String(row.title || ""),
        date(row.publishedDate),
        null,
      );
      if (item) items.push(item);
    }
  }
  return { items, rawCount, truncated, providerCost };
}
export async function collect(
  id: ProviderId,
  site: string,
  key: string | undefined,
  from: number,
  to: number,
): Promise<Batch> {
  const iso = (n: number) => new Date(n).toISOString();
  let url: string,
    init: RequestInit = {};
  if (id === "google")
    url =
      "https://news.google.com/rss/search?" +
      new URLSearchParams({
        q: `site:${site} when:${Math.max(1, Math.ceil((to - from) / 3600000))}h`,
        ...editions[site],
      });
  else {
    url = "https://api.exa.ai/search";
    init = {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key! },
      body: JSON.stringify({
        query: `Latest news articles published by ${site}`,
        type: "auto",
        includeDomains: [site],
        startPublishedDate: iso(from),
        endPublishedDate: iso(to),
        numResults: 10,
      }),
    };
  }
  const batch = parseResults(id, site, await providerRequest(url, init));
  // Apply the precise UTC window locally, including the rounded Google lookback.
  batch.items = batch.items.filter(
    (item) =>
      item.provider_published_at === null ||
      (item.provider_published_at >= from && item.provider_published_at < to),
  );
  return batch;
}
