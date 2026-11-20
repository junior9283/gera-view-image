// Atalhos locais de navegação e zoom. O keymap completo (e os menus) é da Task 6.
import { useEffect } from "react";
import { useUi } from "../store/ui";
import * as actions from "./actions";

export type ViewerShortcut =
  | "next" | "prev" | "first" | "last"
  | "zoomIn" | "zoomOut" | "actualSize" | "fitToWindow"
  | "toggleFullscreen" | "startSlideshow" | "exit";

type KeyLike = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">;

const PLAIN: Record<string, ViewerShortcut> = {
  ArrowRight: "next",
  PageDown: "next",
  ArrowLeft: "prev",
  PageUp: "prev",
  Home: "first",
  End: "last",
  F11: "toggleFullscreen",
  Escape: "exit",
};

export function shortcutFor(e: KeyLike): ViewerShortcut | null {
  if (e.altKey) return null;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (!e.ctrlKey) return e.metaKey || e.shiftKey ? null : (PLAIN[key] ?? null);
  if (key === "f") return e.metaKey ? "toggleFullscreen" : e.shiftKey ? "startSlideshow" : null;
  if (e.metaKey) return null;
  if (key === "=" || key === "+" || e.code === "NumpadAdd") return "zoomIn";
  if (key === "-" || e.code === "NumpadSubtract") return "zoomOut";
  if (e.shiftKey) return null;
  if (key === "0" || e.code === "Numpad0") return "actualSize";
  if (key === "9" || e.code === "Numpad9") return "fitToWindow";
  return null;
}

const RUN: Record<ViewerShortcut, () => unknown> = {
  next: () => actions.next({ wrap: useUi.getState().slideshow }),
  prev: () => actions.prev({ wrap: useUi.getState().slideshow }),
  first: actions.first,
  last: actions.last,
  zoomIn: actions.zoomIn,
  zoomOut: actions.zoomOut,
  actualSize: actions.actualSize,
  fitToWindow: actions.fitToWindow,
  toggleFullscreen: actions.toggleFullscreen,
  startSlideshow: actions.startSlideshow,
  exit: actions.exitModes,
};

const typing = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

/** Liga os atalhos do visualizador na janela enquanto o componente estiver montado. */
export function useViewerShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || typing(e.target)) return;
      const id = shortcutFor(e);
      if (!id) return;
      e.preventDefault();
      Promise.resolve(RUN[id]()).catch((err) => console.error(`atalho ${id}:`, err));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
