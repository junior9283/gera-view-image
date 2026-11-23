// "100% corresponde a" (Preferências › Imagens): um pixel da tela ou o tamanho impresso. A unidade é
// quanto do zoom mostrado vale 1 px CSS por px da imagem: 100% é `escala × unidade = 1`.
import { useEffect, useSyncExternalStore } from "react";
import { DEFAULT_DPI } from "../adjust/units";
import * as ipc from "../ipc/commands";
import type { DocId } from "../ipc/types";
import { useDocs } from "../store/docs";
import { getPrefs, subscribePrefs, usePrefs } from "../store/prefs";
import { dpr } from "./paint";

/** Monitor sem tamanho conhecido: a polegada CSS. */
const DEFAULT_PPI = 96;
const MAX_DPI = 10_000;

const dpis = new Map<DocId, number>();
let screenPpi = DEFAULT_PPI;
const listeners = new Set<() => void>();

const sane = (v: number | null | undefined, fallback: number) =>
  typeof v === "number" && v >= 1 && v <= MAX_DPI ? v : fallback;

function subscribe(l: () => void): () => void {
  listeners.add(l);
  const offs = [subscribePrefs(l), useDocs.subscribe(l), () => listeners.delete(l)];
  return () => offs.forEach((off) => off());
}

/** Unidade do zoom do documento ativo. */
export function zoomUnit(): number {
  if (getPrefs().actualSize === "pixel") return dpr();
  const id = useDocs.getState().activeId;
  return ((id !== null && dpis.get(id)) || DEFAULT_DPI) / screenPpi;
}

/** Pergunta a resolução do documento (da página `page`) e a da tela (o que falhar fica no padrão). */
export async function loadUnit(id: DocId, page = 0): Promise<void> {
  const [dpi, ppi] = await Promise.all([ipc.documentDpi(id, page).catch(() => null), ipc.screenPpi().catch(() => null)]);
  const open = new Set(useDocs.getState().docs.map((d) => d.id));
  for (const k of dpis.keys()) if (!open.has(k)) dpis.delete(k);
  dpis.set(id, sane(dpi, DEFAULT_DPI));
  screenPpi = sane(ppi, DEFAULT_PPI);
  listeners.forEach((l) => l());
}

/**
 * Unidade atual, relida quando mudam o documento, a página, a revisão, a preferência ou a escala, e
 * ao voltar o foco à janela: levada a outro monitor de mesma escala, só o ppi muda.
 */
export function useZoomUnit(id: DocId | undefined, rev: number | undefined, pixelRatio: number, page = 0): number {
  const print = usePrefs((p) => p.actualSize === "print");
  useEffect(() => {
    if (!print || id === undefined) return;
    const load = () => void loadUnit(id, page);
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [print, id, rev, pixelRatio, page]);
  return useSyncExternalStore(subscribe, zoomUnit);
}

/** Só para testes. */
export function resetUnitForTests(): void {
  dpis.clear();
  screenPpi = DEFAULT_PPI;
}
