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
const gdeltDate = (v: string) =>
  date(
    v?.replace(
      /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
      "$1-$2-$3T$4:$5:$6Z",
    ),
  );
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
      });
    }
  } else {
    const data = JSON.parse(body);
    let records: any[];
    if (id === "gdelt") {
      records = data.articles;
      if (!records && Object.keys(data).length === 0) records = [];
    } else if (id === "exa") {
      records = data.results;
      providerCost =
        typeof data.costDollars?.total === "number"
          ? data.costDollars.total
          : null;
    } else if (id === "newsapi") {
      records = data.articles?.results;
      truncated = Number(data.articles?.totalResults) > 100;
    } else records = data.news;
    if (!Array.isArray(records)) throw new Error("Invalid provider response");
    rawCount = records.length;
    truncated ||= rawCount >= (id === "gdelt" ? 250 : id === "exa" ? 10 : 100);
    for (const row of records) {
      const published =
        id === "gdelt"
          ? null
          : date(
              id === "exa"
                ? row.publishedDate
                : id === "newsapi"
                  ? row.dateTimePub
                  : row.date,
            );
      const seen =
        id === "gdelt"
          ? gdeltDate(row.seendate)
          : id === "newsapi"
            ? date(row.dateTime)
            : null;
      const item = sighting(
        site,
        String(row.url || row.link || ""),
        String(row.title || ""),
        published,
        seen,
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
  if (id === "gdelt") {
    const stamp = (n: number) => iso(n).replace(/[-:T]/g, "").slice(0, 14);
    url =
      "https://api.gdeltproject.org/api/v2/doc/doc?" +
      new URLSearchParams({
        query: `domain:${site}`,
        mode: "artlist",
        format: "json",
        maxrecords: "250",
        sort: "datedesc",
        startdatetime: stamp(from),
        enddatetime: stamp(to),
      });
  } else if (id === "google")
    url =
      "https://news.google.com/rss/search?" +
      new URLSearchParams({
        q: `site:${site} when:${Math.max(1, Math.ceil((to - from) / 3600000))}h`,
        ...editions[site],
      });
  else if (id === "exa") {
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
  } else if (id === "newsapi") {
    url = "https://eventregistry.org/api/v1/article/getArticles";
    init = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: key,
        action: "getArticles",
        sourceUri: site,
        dateStart: iso(from).slice(0, 10),
        dateEnd: iso(to).slice(0, 10),
        resultType: "articles",
        articlesSortBy: "date",
        articlesSortByAsc: false,
        articlesCount: 100,
        articlesPage: 1,
        includeArticleBody: false,
      }),
    };
  } else {
    url = "https://google.serper.dev/news";
    init = {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": key! },
      body: JSON.stringify({ q: `site:${site}`, tbs: "qdr:h", num: 100 }),
    };
  }
  const batch = parseResults(id, site, await providerRequest(url, init));
  // NewsAPI accepts dates, not exact timestamps. Apply the precise UTC window locally.
  batch.items = batch.items.filter(
    (item) =>
      item.provider_published_at === null ||
      (item.provider_published_at >= from && item.provider_published_at < to),
  );
  return batch;
}
