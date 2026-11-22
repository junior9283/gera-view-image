// Foco por setas (com volta), Home e End entre os itens de uma lista (abas, menus simples).
import type { KeyboardEvent } from "react";

/** Move o foco entre os `selector` de `e.currentTarget`; devolve o item focado, ou `null` se a tecla não é de navegação. */
export function focusByKeys(e: KeyboardEvent<HTMLElement>, selector: string): HTMLElement | null {
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>(selector)];
  const at = items.indexOf(document.activeElement as HTMLElement);
  const step: Record<string, number> = { ArrowRight: at + 1, ArrowDown: at + 1, ArrowLeft: at - 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 };
  const to = step[e.key];
  if (at < 0 || to === undefined) return null;
  e.preventDefault();
  e.stopPropagation();
  const item = items[(to + items.length) % items.length];
  item.focus();
  return item;
}

/** Teclado de `role="tablist"`: a aba focada também é escolhida. */
export const onTabKeys = (e: KeyboardEvent<HTMLElement>): void => focusByKeys(e, '[role="tab"]')?.click();
