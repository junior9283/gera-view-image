// Fontes do painel Fontes: lista do sistema (carregada uma vez, fora da thread do GTK pelo
// Rust) e a conversão do nome da família para CSS.
import { useEffect, useState } from "react";
import * as ipc from "../ipc/commands";

/** Fontes sempre disponíveis (e as que valem se o sistema não devolver a lista). */
export const BASE_FONTS = ["Inter", "sans-serif", "serif", "monospace"];

let cache: Promise<string[]> | null = null;

/** Lê a lista do Rust uma vez; em erro devolve a falha e tenta de novo na próxima chamada. */
export function loadSystemFonts(): Promise<string[]> {
  const p = (cache ??= ipc.systemFonts());
  p.catch(() => {
    if (cache === p) cache = null;
  });
  return p;
}

export type FontsState = { status: "loading" } | { status: "error" } | { status: "ready"; fonts: string[] };

export function useSystemFonts(): FontsState {
  const [state, setState] = useState<FontsState>({ status: "loading" });
  useEffect(() => {
    let alive = true;
    loadSystemFonts().then(
      (fonts) => alive && setState({ status: "ready", fonts }),
      () => alive && setState({ status: "error" }),
    );
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

/** Só para testes. */
export function resetFontsForTests(): void {
  cache = null;
}
