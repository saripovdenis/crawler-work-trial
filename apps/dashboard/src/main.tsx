import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./pages/App.tsx";
import ReconciliationPage from './pages/reconciliation/ReconciliationPage.tsx';
import FreshnessPage from "./pages/freshness/FreshnessPage.tsx";
import ChartsPage from "./pages/charts/ChartsPage.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {location.pathname === '/freshness' || location.pathname === '/freshness/' ? <FreshnessPage /> : location.pathname.startsWith('/reconciliation') ? <ReconciliationPage /> : location.pathname === '/charts' || location.pathname === '/charts/' ? <ChartsPage /> : <App />}
  </StrictMode>,
);
