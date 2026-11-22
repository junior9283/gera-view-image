// A janela deste WebView (Lote 12: pode haver várias).
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

export const MAIN_WINDOW = "main";

/** Rótulo desta janela (fora do Tauri, o da principal). */
export function windowLabel(): string {
  try {
    return getCurrentWindow().label ?? MAIN_WINDOW;
  } catch {
    return MAIN_WINDOW;
  }
}

/**
 * Ouve um evento mandado a ESTA janela (e os mandados a todas). O `listen` sem alvo ouve também os
 * eventos mandados só a outras janelas.
 */
export const listenHere = <T>(event: string, handler: (payload: T) => void): Promise<() => void> =>
  listen<T>(event, (e) => handler(e.payload), { target: windowLabel() });
