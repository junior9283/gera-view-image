// Página interna de impressão: mostra só a imagem (PNG em resolução cheia vindo do Rust) e abre o
// diálogo de impressão do sistema (`webview.print()`). Ajustar à página e orientação via CSS `@page`.
import { invoke } from "@tauri-apps/api/core";
import i18n from "../i18n";
import { loadPrefs } from "../store/prefs";
import "./print.css";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** CSS de `@page` para a orientação escolhida (`auto` segue a proporção da imagem). */
export function pageCss(orientation: string, img: { w: number; h: number }): string {
  const o = orientation === "auto" ? (img.w > img.h ? "landscape" : "portrait") : orientation;
  return `@page { size: ${o}; margin: 10mm; }`;
}

async function main() {
  await loadPrefs().catch(() => {});
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n]")) el.textContent = i18n.t(el.dataset.i18n!);
  document.title = i18n.t("file.print.title");

  const img = $<HTMLImageElement>("image");
  const fit = $<HTMLInputElement>("fit");
  const orientation = $<HTMLSelectElement>("orientation");
  const page = document.createElement("style");
  document.head.append(page);
  const apply = () => {
    document.body.classList.toggle("print-fit", fit.checked);
    page.textContent = pageCss(orientation.value, { w: img.naturalWidth, h: img.naturalHeight });
  };
  fit.addEventListener("change", apply);
  orientation.addEventListener("change", apply);
  img.addEventListener("load", apply);

  const bytes = await invoke<ArrayBuffer>("print_image");
  img.src = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));

  $("bar").addEventListener("submit", (e) => {
    e.preventDefault();
    void invoke("print_page").catch(console.error);
  });
  $("close").addEventListener("click", () => void invoke("print_close"));
  document.addEventListener("keydown", (e) => e.key === "Escape" && void invoke("print_close"));
}

void main().catch(console.error);
