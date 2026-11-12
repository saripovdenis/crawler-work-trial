import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { Observatory } from "../metrics/observability.js";
import { Charts } from "../metrics/charts.js";

import { CoverageReader } from "../../../../packages/reconciliation/src/view.js";
const coverage = new CoverageReader(resolve(process.env.RECONCILER_DB || "data/reconciler.sqlite"), resolve(process.env.CRAWLER_DATA_DIR || "data", "crawler.sqlite"));

const charts = new Charts(resolve(process.env.CRAWLER_DATA_DIR || "data"));

const observation = new Observatory(
  resolve(process.env.CRAWLER_DATA_DIR || "data"),
);
const staticDir = resolve(process.env.DASHBOARD_DIST || "apps/dashboard/dist");
const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};
let windowStart = Date.now(),
  requestsInWindow = 0,
  inspecting = 0;
const server = createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'",
  );
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    res.end();
    return;
  }
  const url = new URL(req.url || "/", "http://localhost");
  try {
    if (url.pathname.startsWith("/api/")) {
      if (Date.now() - windowStart > 10_000) {
        windowStart = Date.now();
        requestsInWindow = 0;
      }
      if (++requestsInWindow > 300) {
        res.writeHead(429, { "Retry-After": "10" });
        res.end();
        return;
      }
      let result: unknown;
      if (url.pathname === "/api/reconciliation") result = coverage.get(url.searchParams);
      else if (url.pathname === "/api/charts/parsing-quality") result = charts.parsingQuality(url.searchParams);
      else if (url.pathname === "/api/overview") result = observation.overview();
      else if (url.pathname === "/api/requests")
        result = observation.requests(url.searchParams);
      else if (url.pathname === "/api/articles")
        result = observation.articles(url.searchParams);
      else if (url.pathname === "/api/sources")
        result = observation.sources(url.searchParams);
      else if (/^\/api\/requests\/\d+$/.test(url.pathname)) {
        if (inspecting >= 2) {
          res.writeHead(429, { "Retry-After": "2" });
          res.end();
          return;
        }
        inspecting++;
        try {
          result = await observation.requestDetail(
            Number(url.pathname.split("/").at(-1)),
          );
        } finally {
          inspecting--;
        }
      } else if (url.pathname === "/api/health") result = { ok: true };
      else {
        res.writeHead(404);
        res.end();
        return;
      }
      if (result === null) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=5",
      });
      res.end(req.method === "HEAD" ? undefined : JSON.stringify(result));
      return;
    }
    const path = resolve(staticDir, "." + decodeURIComponent(url.pathname));
    if (path !== staticDir && !path.startsWith(staticDir + "/")) {
      res.writeHead(403);
      res.end();
      return;
    }
    let file = path;
    let bytes;
    try {
      bytes = await readFile(file);
    } catch {
      file = resolve(staticDir, "index.html");
      bytes = await readFile(file);
    }
    res.writeHead(200, {
      "Content-Type": mime[extname(file)] || "application/octet-stream",
      "Cache-Control": file.endsWith(".html")
        ? "no-cache"
        : "public, max-age=86400",
    });
    res.end(req.method === "HEAD" ? undefined : bytes);
  } catch (e) {
    const bad = String(e).includes("Invalid");
    res.writeHead(bad ? 400 : 503, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(
      JSON.stringify({
        error: bad ? "Invalid filter" : "Data temporarily unavailable",
      }),
    );
  }
});
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.listen(
  Number(process.env.PORT || 4318),
  process.env.HOST || "127.0.0.1",
  () =>
    console.log("Observability API listening on " + (process.env.PORT || 4318)),
);
for (const event of ["SIGTERM", "SIGINT"])
  process.on(event, () =>
    server.close(() => {
      observation.db.close();
      charts.db.close();
      process.exit(0);
    }),
  );
