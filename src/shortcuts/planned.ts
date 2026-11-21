// Comandos criados pelo Lote 0 (Fiação) e o lote de paridade que vai implementá-los
// (`paridade-auditoria.md`, guia em `docs/arquitetura/extensao.md`). Até o lote dono chamar
// `registerCommand` no próprio arquivo, o item aparece no menu desabilitado e o atalho não faz nada.
import type { CommandId } from "./commands";

export type Lote = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

export const PLANNED = {
  "tools.assignProfile": 1,

  "edit.find": 3,
  "edit.findNext": 3,
  "edit.findPrev": 3,
  "edit.startSpeaking": 3,
  "edit.stopSpeaking": 3,
  "tools.liveText": 3,
  "tools.copyAllText": 3,
  "tools.translateText": 3,
  "tools.searchText": 3,
  "tools.searchImageWeb": 3,

  "tools.removeBackground": 4,
  "tools.copySubject": 4,

  "file.saveAs": 5,
  "file.moveToTrash": 5,
  "file.tags": 5,
  "file.lock": 5,
  "file.browseVersions": 5,

  "view.toolbar": 6,
  "view.customizeToolbar": 6,
  "file.shareEmail": 6,
  "file.shareDevice": 6,
  "help.search": 6,

  "view.sortByName": 7,
  "view.sortByDate": 7,
  "view.sortByKind": 7,
  "view.sortBySize": 7,

  "tools.magnifier": 8,
  "view.imageBackground": 8,
  "go.back": 8,
  "go.forward": 8,
  "file.closeAll": 8,

  "tools.imageDescription": 9,

  "tools.showColors": 10,
  "tools.showFonts": 10,
  "tools.markupInspector": 10,

  "file.exportPdf": 11,

  "file.closeWindow": 12,
  "view.tabBar": 12,
  "view.allTabs": 12,
  "window.prevTab": 12,
  "window.nextTab": 12,
  "window.moveTabToNewWindow": 12,
  "window.mergeAllWindows": 12,
  "window.bringAllToFront": 12,
  "file.importScanner": 12,
} as const satisfies Partial<Record<CommandId, Lote>>;

export type PlannedCommand = keyof typeof PLANNED;
