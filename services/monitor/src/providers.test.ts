import test from "node:test";
import assert from "node:assert/strict";
import { sites } from "../../../config/sites.js";
import { editions } from "../../../config/monitor.js";
import { parseResults, collect } from "./providers.js";
import { validateProviderUrl, providerRequest } from "./client.js";
const stamp = "2026-11-12T08:00:00Z";
const url = "https://www.bbc.com/news/articles/test";
test("provider parsers filter publishers, retain provenance and distinguish timestamps", () => {
  const gdelt = parseResults(
    "gdelt",
    "bbc.com",
    JSON.stringify({
      articles: [
        { url, title: "BBC story", seendate: "20261112T080000Z" },
        { url: "https://evilbbc.com/no", title: "wrong" },
      ],
    }),
  );
  assert.equal(gdelt.items.length, 1);
  assert.equal(gdelt.items[0].provider_published_at, null);
  assert.equal(gdelt.items[0].provider_first_seen_at, Date.parse(stamp));
  assert.equal(parseResults("gdelt", "bbc.com", "{}").items.length, 0);
  const exa = parseResults(
    "exa",
    "bbc.com",
    JSON.stringify({
      results: Array(10).fill({ url, title: "Story", publishedDate: stamp }),
      costDollars: { total: 0.007 },
    }),
  );
  assert.equal(exa.truncated, true);
  assert.equal(exa.providerCost, 0.007);
  const news = parseResults(
    "newsapi",
    "bbc.com",
    JSON.stringify({
      articles: {
        totalResults: 500,
        results: [{ url, title: "Story", dateTime: stamp }],
      },
    }),
  );
  assert.equal(news.truncated, true);
  assert.equal(news.items[0].provider_published_at, null);
  assert.equal(news.items[0].provider_first_seen_at, Date.parse(stamp));
  assert.equal(
    parseResults(
      "serper",
      "bbc.com",
      JSON.stringify({ news: [{ link: url, title: "Story", date: stamp }] }),
    ).items.length,
    1,
  );
  const google = parseResults(
    "google",
    "bbc.com",
    `<rss><channel><item><title>BBC story - BBC</title><link>https://news.google.com/rss/articles/wrapper</link><source url="https://www.bbc.com">BBC</source><pubDate>Thu, 12 Nov 2026 08:00:00 GMT</pubDate></item><item><title>Wrong</title><link>https://evil.com/article</link><source url="https://evil.com">evil</source></item></channel></rss>`,
  );
  assert.equal(google.items.length, 1);
  assert.equal(google.items[0].title, "BBC story");
  assert.equal(google.items[0].url_key, null);
  for (const site of sites) assert.ok(editions[site.domain]);
  assert.throws(() => parseResults("exa", "bbc.com", "{}"), /Invalid/);
  assert.throws(
    () => parseResults("google", "bbc.com", "<html>Error</html>"),
    /Invalid/,
  );
});
test("provider client rejects all publisher domains, alternate destinations and redirects", async (t) => {
  for (const site of sites)
    for (const prefix of ["", "www.", "news."])
      assert.throws(
        () => validateProviderUrl(`https://${prefix}${site.domain}/news`),
        /refused/,
      );
  for (const destination of [
    "http://api.exa.ai/search",
    "https://api.exa.ai/contents",
    "https://api.exa.ai.evil.com/search",
    "https://u:p@api.exa.ai/search",
    "https://api.exa.ai:444/search",
    "https://127.0.0.1/search",
  ])
    assert.throws(() => validateProviderUrl(destination));
  const calls: any[] = [];
  t.mock.method(globalThis, "fetch", async (input: any, init: any) => {
    calls.push([input, init]);
    return new Response("", { status: 302, headers: { location: url } });
  });
  await assert.rejects(
    providerRequest("https://api.exa.ai/search"),
    /HTTP 302/,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].redirect, "manual");
});
test("NewsAPI exact time filter excludes old same-day results and makes only one request", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_input: any, init: any) => {
    calls++;
    assert.equal(JSON.parse(init.body).articlesCount, 100);
    return Response.json({
      articles: {
        results: [
          { url, title: "Recent", dateTimePub: stamp },
          {
            url: url + "old",
            title: "Old",
            dateTimePub: "2026-11-12T01:00:00Z",
          },
        ],
      },
    });
  });
  const result = await collect(
    "newsapi",
    "bbc.com",
    "test",
    Date.parse(stamp) - 3600000,
    Date.parse(stamp) + 1,
  );
  assert.equal(calls, 1);
  assert.equal(result.items.length, 1);
});
