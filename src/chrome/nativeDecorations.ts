import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Provisório: a Task 12 migra a decisão para as prefs (`prefs.nativeDecorations`). */
const KEY = "gvi.nativeDecorations";

function readStored(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

let native = readStored();
const listeners = new Set<() => void>();

/** Fallback automático (spec §13.3): decoração nativa, guardada para as próximas aberturas. */
export function enableNativeDecorations(): void {
  if (native) return;
  native = true;
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    /* sem armazenamento: vale só nesta sessão */
  }
  listeners.forEach((l) => l());
}

/** Só para testes: relê o armazenamento. */
export function resetNativeDecorations(): void {
  native = readStored();
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** `override` é o ajuste manual (prop); o fallback automático também liga o modo nativo. */
export function useNativeDecorations(override = false): boolean {
  return useSyncExternalStore(subscribe, () => native) || override;
}

/** Na inicialização: sem compositor/visual RGBA a janela transparente não funciona. */
export function useCompositingProbe(): void {
  useEffect(() => {
    invoke<boolean>("compositing_available")
      .then((ok) => ok || enableNativeDecorations())
      .catch(() => {});
  }, []);
}

/** Liga `setDecorations(true)` sempre que o modo nativo estiver ativo. */
export function useApplyNativeDecorations(active: boolean): void {
  useEffect(() => {
    if (active) getCurrentWindow().setDecorations(true).catch(() => {});
  }, [active]);
}
