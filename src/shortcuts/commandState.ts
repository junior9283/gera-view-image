// Estado dos comandos de alternância: o rótulo certo (Mostrar/Ocultar) ou o ✓ do menu.
import { inspectorOpen, subscribeInspector } from "../inspector/toggle";
import { scannerHint } from "../file/scan";
import { useMarkup, type BarMenu } from "../markup/store";
import { getPrefs, subscribePrefs, type Prefs } from "../store/prefs";
import { useUi, type SidebarMode } from "../store/ui";
import { magnifierOn, subscribeMagnifier } from "../viewer/Magnifier";
import type { CommandId } from "./commands";

export interface CommandState {
  /** Ligado (botão pressionado na barra de ferramentas). */
  on?: boolean;
  /** Rótulo (chave de i18n) no lugar do fixo do menu. */
  label?: string;
  /** Item de escolha única. */
  checked?: boolean;
  /** Dica do item (chave de i18n), ex.: por que está desabilitado. */
  title?: string;
}

const NONE: CommandState = {};

/** Alterna entre o rótulo do menu (desligado) e `<rótulo>Hide` (ligado). */
const toggle = (command: CommandId, on: () => boolean, hide = `menu.${command}Hide`) => () => {
  const v = on();
  return { on: v, label: v ? hide : undefined };
};
const sidebar = (mode: SidebarMode) => () => {
  const v = useUi.getState().sidebar === mode;
  return { on: v, checked: v };
};
const sort = (by: Prefs["sortBy"]) => () => ({ checked: getPrefs().sortBy === by });
const panel = (command: CommandId, menu: BarMenu) =>
  toggle(command, () => {
    const s = useMarkup.getState();
    return s.visible && s.menu === menu;
  });

const STATES: Partial<Record<CommandId, () => CommandState>> = {
  "view.hideSidebar": sidebar("hidden"),
  "view.thumbnails": sidebar("thumbs"),
  "view.contactSheet": sidebar("contact"),
  "view.sortByName": sort("name"),
  "view.sortByDate": sort("date"),
  "view.sortByKind": sort("kind"),
  "view.sortBySize": sort("size"),
  "view.markupBar": toggle("view.markupBar", () => useMarkup.getState().visible),
  // O rótulo fixo já é o de ocultar (a barra começa visível).
  "view.toolbar": () => ({ label: getPrefs().toolbarHidden ? "menu.view.toolbarShow" : undefined }),
  "view.imageBackground": toggle("view.imageBackground", () => getPrefs().showImageBackground),
  "view.tabBar": toggle("view.tabBar", () => getPrefs().tabBar),
  "view.fullscreen": toggle("view.fullscreen", () => useUi.getState().fullscreen),
  "tools.inspector": toggle("tools.inspector", inspectorOpen),
  "tools.magnifier": toggle("tools.magnifier", magnifierOn),
  "tools.liveText": toggle("tools.liveText", () => getPrefs().liveText),
  "tools.showColors": panel("tools.showColors", "colors"),
  "tools.showFonts": panel("tools.showFonts", "fonts"),
  "tools.markupInspector": panel("tools.markupInspector", "properties"),
  "file.importScanner": () => ({ title: scannerHint() }),
};

export const commandState = (id: CommandId): CommandState => STATES[id]?.() ?? NONE;

/** Avisa quando o estado de algum comando pode ter mudado. */
export function subscribeCommandState(l: () => void): () => void {
  const offs = [useUi.subscribe(l), useMarkup.subscribe(l), subscribePrefs(l), subscribeInspector(l), subscribeMagnifier(l)];
  return () => offs.forEach((off) => off());
}

/** Resumo do estado de todos, para o `useSyncExternalStore`. */
export const commandStates = (): string =>
  Object.values(STATES).map((f) => {
    const s = f();
    return `${s.label ?? ""}${s.checked ? "✓" : ""}`;
  }).join("|");
