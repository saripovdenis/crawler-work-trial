import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./dashboard.css";
import App from "./pages/App.tsx";
import SummaryPage from "./pages/summary/SummaryPage.tsx";
import CrawlerOnlyPage from "./pages/crawler-only/CrawlerOnlyPage.tsx";

const path = location.pathname.replace(/\/+$/, "");
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {path === "/crawler-only" ? <CrawlerOnlyPage /> : path === "/freshness" ? <SummaryPage key="freshness" kind="freshness" />
      : path.startsWith("/reconciliation") ? <SummaryPage key="coverage" kind="coverage" /> : <App />}
  </StrictMode>,
);
