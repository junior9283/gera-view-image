import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { setPrefs, usePrefs } from "../store/prefs";

/** Fallback automático (spec §13.3): decoração nativa, guardada nas prefs para as próximas aberturas. */
export function enableNativeDecorations(): void {
  setPrefs({ nativeDecorations: true });
}

/** `override` é o ajuste manual (prop); `prefs.nativeDecorations` também liga o modo nativo. */
export function useNativeDecorations(override = false): boolean {
  return usePrefs().nativeDecorations || override;
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
