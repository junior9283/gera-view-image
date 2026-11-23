// Base compartilhada dos diálogos e folhas modais: foco inicial no primeiro controle, Tab e
// Shift+Tab presos dentro do diálogo, Esc fecha (mesmo com o foco fora dele) e, ao fechar, o
// foco volta ao elemento que estava focado antes de abrir.
import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = [
  "a[href]", "button:not([disabled])", "input:not([disabled]):not([type=hidden])", "select:not([disabled])",
  "textarea:not([disabled])", "[tabindex]:not([tabindex='-1'])", "[contenteditable='true']",
].join(",");

/** Controles focáveis de `root`, na ordem do documento. */
export const focusables = (root: HTMLElement): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getAttribute("tabindex") !== "-1" && !el.closest("[hidden],[inert]"));

/** Modais abertos (o último é o de cima: só ele trata Tab e Esc). */
const stack: RefObject<HTMLElement | null>[] = [];

interface Options {
  /** Esc fecha o diálogo (sem ele, Esc não faz nada). */
  onClose?: () => void;
  /** Controle que recebe o foco ao abrir, em vez do primeiro. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Para diálogos sempre montados que só às vezes aparecem. Padrão: `true`. */
  active?: boolean;
}

export function useModal(ref: RefObject<HTMLElement | null>, { onClose, initialFocus, active = true }: Options = {}): void {
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    if (!active) return;
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    stack.push(ref);
    const root = ref.current;
    if (root && !root.contains(document.activeElement)) {
      const first = initialFocus?.current ?? focusables(root)[0];
      if (first) first.focus();
      else {
        if (!root.hasAttribute("tabindex")) root.tabIndex = -1;
        root.focus();
      }
    }
    const onKey = (e: KeyboardEvent) => {
      const el = ref.current;
      if (!el || stack[stack.length - 1] !== ref) return;
      if (e.key === "Escape") {
        if (!close.current) return;
        e.preventDefault();
        e.stopPropagation();
        close.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables(el);
      e.preventDefault();
      if (!items.length) return el.focus();
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : at < 0 || at === items.length - 1 ? 0 : at + 1;
      items[next].focus();
    };
    // Captura no documento: chega antes dos ouvintes do app (atalhos, Esc que desmarca).
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      stack.splice(stack.indexOf(ref), 1);
      if (origin?.isConnected) origin.focus();
    };
    // `initialFocus` só vale na abertura.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, ref]);
}
