// Campo Pesquisar do menu Ajuda: procura itens de menu pelo rótulo traduzido (como o do macOS).
import type { CommandId } from "../shortcuts/commands";
import { commandState } from "../shortcuts/commandState";
import type { Menu, MenuItem } from "./menus";

export interface MenuHit {
  command: CommandId;
  label: string;
  /** Menus e submenus até o item (ex.: ["Arquivo", "Reverter Para"]). */
  path: string[];
}

/** Minúsculas, sem acento nem reticências. */
const fold = (s: string) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").replace(/…/g, "").toLowerCase();

function leaves(items: MenuItem[], path: string[], t: (k: string) => string, out: MenuHit[]): void {
  for (const it of items) {
    if ("separator" in it) continue;
    if (it.submenu) leaves(it.submenu, [...path, t(it.label)], t, out);
    else if (it.command !== "help.search") out.push({ command: it.command, label: t(commandState(it.command).label ?? it.label).replace(/…$/, ""), path });
  }
}

/** Itens cujo rótulo tem todas as palavras de `query`; os que começam com ela vêm primeiro. */
export function searchMenus(query: string, menus: Menu[], t: (k: string) => string, limit = 12): MenuHit[] {
  const q = fold(query).trim();
  if (!q) return [];
  const words = q.split(/\s+/);
  const all: MenuHit[] = [];
  for (const m of menus) leaves(m.items, [t(m.label)], t, all);
  return all
    .map((h) => ({ h, f: fold(h.label) }))
    .filter(({ f }) => words.every((w) => f.includes(w)))
    .sort((a, b) => Number(!a.f.startsWith(q)) - Number(!b.f.startsWith(q)))
    .slice(0, limit)
    .map(({ h }) => h);
}
