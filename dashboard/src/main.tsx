import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import ChartsPage from "./charts/ChartsPage.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {location.pathname === '/charts' || location.pathname === '/charts/' ? <ChartsPage /> : <App />}
  </StrictMode>,
);
