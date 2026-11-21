import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./i18n";
import "./markup/register";
// Pontos de registro dos lotes de paridade (docs/arquitetura/extensao.md). Lote 2 usa
// `select/register` (importado pelo App) e Lote 10, `markup/register`.
import "./color/register";
import "./livetext/register";
import "./select/subject";
import "./finder/register";
import "./chrome/register";
import "./sidebar/register";
import "./viewer/register";
import "./inspector/register";
import "./print/register";
import "./tabs/register";
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
