import { useEffect, useRef, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { usePrefs } from "../store/prefs";

// Fallback automático (spec §13.3): vale só nesta sessão e nunca é gravado, para não virar a
// escolha do usuário (`prefs.nativeDecorations`) nem sobreviver a um falso negativo da sonda.
let forcedNative = false;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function enableNativeDecorations(): void {
  if (forcedNative) return;
  forcedNative = true;
  listeners.forEach((l) => l());
}

/** Só para testes. */
export function resetForcedNative(): void {
  forcedNative = false;
  listeners.forEach((l) => l());
}

/** Verdadeiro quando o sistema não suporta a janela sem decoração (nesta sessão). */
export function useForcedNative(): boolean {
  return useSyncExternalStore(subscribe, () => forcedNative);
}

/** `override` é o ajuste manual (prop); a preferência do usuário e o fallback da sessão também ligam o modo nativo. */
export function useNativeDecorations(override = false): boolean {
  const forced = useForcedNative();
  return usePrefs((p) => p.nativeDecorations) || forced || override;
}

/** Na inicialização: sem compositor/visual RGBA a janela transparente não funciona. */
export function useCompositingProbe(): void {
  useEffect(() => {
    invoke<boolean>("compositing_available")
      .then((ok) => ok || enableNativeDecorations())
      .catch(() => {});
  }, []);
}

/** Aplica `setDecorations` ao ligar o modo nativo e o desfaz (`false`) quando a preferência é desligada. */
export function useApplyNativeDecorations(active: boolean): void {
  const wasActive = useRef(false);
  useEffect(() => {
    if (active || wasActive.current) getCurrentWindow().setDecorations(active).catch(() => {});
    wasActive.current = active;
  }, [active]);
}
