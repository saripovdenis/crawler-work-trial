import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./pages/App.tsx";
import ChartsPage from "./pages/charts/ChartsPage.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {location.pathname === '/charts' || location.pathname === '/charts/' ? <ChartsPage /> : <App />}
  </StrictMode>,
);
