// Barra de menus declarativa (rótulos são chaves de i18n). Item cujo comando não está registrado
// aparece desabilitado; submenu fica desabilitado se nenhum filho estiver habilitado.
import { ANNOTATE_KINDS, type CommandId } from "../shortcuts/commands";

export type MenuItem =
  | { label: string; command: CommandId; submenu?: never }
  | { label: string; submenu: MenuItem[]; command?: never }
  | { separator: true };

export interface Menu {
  label: string;
  items: MenuItem[];
}

const SEP: MenuItem = { separator: true };
const item = (group: string, name: string, command = `${group}.${name}` as CommandId): MenuItem => ({
  label: `menu.${group}.${name}`,
  command,
});

/** Atalho para vários itens do mesmo grupo. */
const items = (group: string, ...names: string[]) => names.map((n) => item(group, n));
const submenu = (label: string, list: MenuItem[]): MenuItem => ({ label, submenu: list });

// Ordem e nomes seguem o Pré-Visualização do macOS 14/15. Os itens dos lotes de paridade
// (`src/shortcuts/planned.ts`) ficam desabilitados até o lote registrar o comando.
export const MENUS: Menu[] = [
  {
    label: "menu.file.title",
    items: [
      ...items("file", "newFromClipboard", "open"),
      SEP,
      ...items("file", "close", "closeAll", "closeWindow", "save", "duplicate", "saveAs", "rename", "moveTo", "moveToTrash"),
      ...items("file", "tags", "lock", "showInFolder", "openWith"),
      submenu("menu.file.revert", [...items("file", "revertLastSaved", "revertOriginal"), SEP, item("file", "browseVersions")]),
      SEP,
      ...items("file", "export", "exportSelected", "exportPdf"),
      SEP,
      submenu("menu.file.share", items("file", "shareEmail", "shareDevice")),
      SEP,
      item("file", "importScanner"),
      submenu("menu.file.capture", items("file", "captureSelection", "captureWindow", "captureScreen")),
      SEP,
      item("file", "print"),
      SEP,
      item("file", "quit"),
    ],
  },
  {
    label: "menu.edit.title",
    items: [
      ...items("edit", "undo", "redo"),
      SEP,
      ...items("edit", "cut", "copy", "paste", "duplicate", "delete", "selectAll", "deselect", "invertSelection"),
      SEP,
      submenu("menu.edit.findMenu", items("edit", "find", "findNext", "findPrev")),
      submenu("menu.edit.speech", items("edit", "startSpeaking", "stopSpeaking")),
      SEP,
      item("edit", "preferences"),
    ],
  },
  {
    label: "menu.view.title",
    items: [
      ...items("view", "hideSidebar", "thumbnails", "contactSheet"),
      SEP,
      submenu("menu.view.sortBy", items("view", "sortByName", "sortByDate", "sortByKind", "sortBySize")),
      SEP,
      ...items("view", "actualSize", "fit", "zoomIn", "zoomOut", "zoomToSelection"),
      SEP,
      item("view", "imageBackground"),
      submenu("menu.view.softProof", [item("view", "softProofNone"), SEP, item("view", "softProofChoose")]),
      SEP,
      ...items("view", "markupBar", "toolbar", "customizeToolbar"),
      SEP,
      ...items("view", "tabBar", "allTabs"),
      SEP,
      ...items("view", "slideshow", "fullscreen"),
    ],
  },
  {
    label: "menu.go.title",
    items: [...items("go", "back", "forward"), SEP, ...items("go", "prev", "next"), SEP, ...items("go", "first", "last")],
  },
  {
    label: "menu.tools.title",
    items: [
      ...items("tools", "rotateLeft", "rotateRight", "flipH", "flipV"),
      SEP,
      ...items("tools", "crop", "adjustColor", "resize", "assignProfile"),
      SEP,
      ...items("tools", "selectRect", "selectEllipse", "selectLasso", "selectSmartLasso"),
      ...items("tools", "instantAlpha", "removeBackground", "copySubject"),
      SEP,
      ...items("tools", "magnifier", "inspector", "markupInspector", "showColors", "showFonts", "imageDescription"),
      SEP,
      submenu("menu.tools.liveTextMenu", [
        ...items("tools", "liveText", "copyAllText"),
        SEP,
        ...items("tools", "translateText", "searchText", "searchImageWeb"),
      ]),
      SEP,
      submenu(
        "menu.tools.annotate",
        ANNOTATE_KINDS.map((k) => item("tools", `annotateKinds.${k}`, `tools.annotate.${k}`)),
      ),
    ],
  },
  {
    label: "menu.window.title",
    items: [
      ...items("window", "minimize", "maximize"),
      SEP,
      ...items("window", "prevTab", "nextTab", "moveTabToNewWindow", "mergeAllWindows"),
      SEP,
      item("window", "bringAllToFront"),
    ],
  },
  {
    label: "menu.help.title",
    items: [item("help", "search"), SEP, item("help", "shortcuts"), SEP, ...items("help", "checkUpdates", "about")],
  },
];
