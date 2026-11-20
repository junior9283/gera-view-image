import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./i18n";
import "./markup/register";
import { loadPrefs } from "./store/prefs";
import "./App.css";

// Gancho do E2E/capturas: o import dinâmico some do build normal.
if (import.meta.env.VITE_E2E) void import("./e2e/hook").then((m) => m.installE2eHook());

// Carrega as preferências antes de desenhar, para o idioma e a decoração já saírem certos.
void loadPrefs().finally(() =>
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  ),
);
