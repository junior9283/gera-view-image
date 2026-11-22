// Lote 12 (Janelas e Abas): ponto de registro exclusivo deste lote, importado uma vez no `main.tsx`.
// Importar do Scanner (`file.importScanner`) ainda não existe e continua desabilitado.
import * as ipc from "../ipc/commands";
import { registerSlot } from "../lib/slots";
import { registerCommand } from "../shortcuts/commands";
import { useDocs } from "../store/docs";
import { getPrefs, setPrefs } from "../store/prefs";
import { next, prev } from "../viewer/actions";
import { TabsOverlays } from "./AllTabs";
import { closeThisWindow } from "./closing";
import { hasOtherWindows, showOverview, useTabs } from "./store";
import { TabBar } from "./TabBar";
import { mergeAllWindows, movable, moveTabToNewWindow } from "./transfer";

const hasDocs = () => useDocs.getState().docs.length > 0;
const many = () => useDocs.getState().docs.length > 1;

registerCommand("file.closeWindow", closeThisWindow);
registerCommand("view.tabBar", () => setPrefs({ tabBar: !getPrefs().tabBar }));
registerCommand("view.allTabs", () => showOverview(!useTabs.getState().overview), hasDocs);
registerCommand("window.prevTab", () => prev({ wrap: true }), many);
registerCommand("window.nextTab", () => next({ wrap: true }), many);
registerCommand("window.moveTabToNewWindow", moveTabToNewWindow, () => movable().length > 0);
registerCommand("window.bringAllToFront", ipc.bringAllToFront);
registerSlot("above-content", "tab-bar", TabBar);
registerSlot("above-content", "tabs-overlays", TabsOverlays);

// Registrar de novo avisa os menus quando passa a haver (ou deixa de haver) outra janela.
const registerMerge = () => registerCommand("window.mergeAllWindows", mergeAllWindows, hasOtherWindows);
registerMerge();
useTabs.subscribe((s, old) => {
  if (s.windows.length > 1 !== old.windows.length > 1) registerMerge();
});
