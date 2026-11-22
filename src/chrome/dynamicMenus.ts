// Submenus cujos itens só se conhecem na hora (ex.: perfis instalados da Prova de Cor). A parte fixa
// continua em `menus.ts`; quem é dono do submenu registra aqui como completá-la.
import { useSyncExternalStore } from "react";
import type { ListItem } from "./MenuBar";
import type { MenuItem } from "./menus";

export interface DynamicMenu {
  /** Itens a mostrar, a partir dos fixos. */
  build: (items: MenuItem[]) => ListItem[];
  /** O submenu abriu: hora de buscar o que falta. */
  onOpen?: () => void;
}

const menus = new Map<string, DynamicMenu>();
const listeners = new Set<() => void>();
let version = 0;

/** Os itens mudaram: redesenha o submenu aberto. */
export function refreshDynamicMenus(): void {
  version++;
  listeners.forEach((l) => l());
}

/** Registra o submenu de rótulo `label` (chave de i18n); devolve a função que o remove. */
export function registerDynamicMenu(label: string, menu: DynamicMenu): () => void {
  menus.set(label, menu);
  return () => {
    if (menus.get(label) === menu) menus.delete(label);
  };
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export function useDynamicMenu(label: string | undefined): DynamicMenu | undefined {
  useSyncExternalStore(subscribe, () => version);
  return label === undefined ? undefined : menus.get(label);
}
