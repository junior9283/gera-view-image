import { useEffect, useLayoutEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { subscribe } from "../lib/events";
import { readableOn } from "./contrast";

export type WinButton = "minimize" | "maximize" | "close";
export type DecorationStyle = "breeze" | "adwaita" | "elementary" | "generic";

/** Espelha `WindowTheme` de `src-tauri/src/theme/detect.rs`. */
export interface WindowTheme {
  layout: { left: WinButton[]; right: WinButton[] };
  style: DecorationStyle;
  dark: boolean;
  accent: string | null;
  icons: { close: string; minimize: string; maximize: string; restore: string } | null;
  colors: { activeBg: string; activeFg: string; inactiveBg: string; inactiveFg: string } | null;
}

const FALLBACK_THEME: WindowTheme = {
  layout: { left: [], right: ["minimize", "maximize", "close"] },
  style: "generic",
  dark: false,
  accent: null,
  icons: null,
  colors: null,
};

/** Tema do sistema, ao vivo: comando `window_theme` + evento `window-theme-changed`. */
export function useWindowTheme(): WindowTheme {
  // Antes da primeira resposta do backend, segue o prefers-color-scheme (evita o flash claro).
  const [theme, setTheme] = useState<WindowTheme>(() => ({
    ...FALLBACK_THEME,
    dark: window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
  }));

  useEffect(() => {
    let alive = true;
    // Registra o ouvinte antes de ler, para não perder uma mudança entre as duas etapas.
    const off = subscribe(listen<WindowTheme>("window-theme-changed", (e) => alive && setTheme(e.payload)));
    invoke<WindowTheme>("window_theme")
      .then((t) => alive && setTheme(t))
      .catch(() => {});
    return () => {
      alive = false;
      off();
    };
  }, []);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme.dark ? "dark" : "light";
  }, [theme.dark]);

  // Menus e realces usam a cor de destaque do sistema, com o texto que dá para ler sobre ela.
  useLayoutEffect(() => {
    if (!theme.accent) return;
    const { style } = document.documentElement;
    style.setProperty("--wm-accent", theme.accent);
    style.setProperty("--wm-accent-fg", readableOn(theme.accent));
    return () => {
      style.removeProperty("--wm-accent");
      style.removeProperty("--wm-accent-fg");
    };
  }, [theme.accent]);

  return theme;
}
