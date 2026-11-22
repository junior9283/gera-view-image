// Teclado de `role="tablist"`: setas (com volta), Home e End focam e escolhem a aba.
import type { KeyboardEvent } from "react";

export function onTabKeys(e: KeyboardEvent<HTMLElement>): void {
  const tabs = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')];
  const at = tabs.indexOf(document.activeElement as HTMLElement);
  const step: Record<string, number> = { ArrowRight: at + 1, ArrowDown: at + 1, ArrowLeft: at - 1, ArrowUp: at - 1, Home: 0, End: tabs.length - 1 };
  const to = step[e.key];
  if (at < 0 || to === undefined) return;
  e.preventDefault();
  e.stopPropagation();
  const tab = tabs[(to + tabs.length) % tabs.length];
  tab.focus();
  tab.click();
}
