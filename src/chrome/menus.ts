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

export const MENUS: Menu[] = [
  {
    label: "menu.file.title",
    items: [
      item("file", "newFromClipboard"),
      item("file", "open"),
      item("file", "openRecent"),
      SEP,
      item("file", "close"),
      item("file", "save"),
      item("file", "duplicate"),
      item("file", "rename"),
      item("file", "moveTo"),
      { label: "menu.file.revert", submenu: [item("file", "revertLastSaved"), item("file", "revertOriginal")] },
      SEP,
      item("file", "export"),
      item("file", "exportSelected"),
      SEP,
      {
        label: "menu.file.capture",
        submenu: [item("file", "captureSelection"), item("file", "captureWindow"), item("file", "captureScreen")],
      },
      SEP,
      item("file", "print"),
    ],
  },
  {
    label: "menu.edit.title",
    items: [
      item("edit", "undo"),
      item("edit", "redo"),
      SEP,
      item("edit", "cut"),
      item("edit", "copy"),
      item("edit", "paste"),
      item("edit", "delete"),
      item("edit", "selectAll"),
      item("edit", "deselect"),
      item("edit", "invertSelection"),
      SEP,
      item("edit", "preferences"),
    ],
  },
  {
    label: "menu.view.title",
    items: [
      item("view", "hideSidebar"),
      item("view", "thumbnails"),
      item("view", "contactSheet"),
      SEP,
      item("view", "actualSize"),
      item("view", "fit"),
      item("view", "zoomIn"),
      item("view", "zoomOut"),
      item("view", "zoomToSelection"),
      SEP,
      item("view", "markupBar"),
      SEP,
      item("view", "slideshow"),
      item("view", "fullscreen"),
    ],
  },
  {
    label: "menu.go.title",
    items: [item("go", "prev"), item("go", "next"), SEP, item("go", "first"), item("go", "last")],
  },
  {
    label: "menu.tools.title",
    items: [
      item("tools", "rotateLeft"),
      item("tools", "rotateRight"),
      item("tools", "flipH"),
      item("tools", "flipV"),
      SEP,
      item("tools", "crop"),
      item("tools", "adjustColor"),
      item("tools", "resize"),
      item("tools", "instantAlpha"),
      SEP,
      item("tools", "inspector"),
      SEP,
      {
        label: "menu.tools.annotate",
        submenu: ANNOTATE_KINDS.map((k) => item("tools", `annotateKinds.${k}`, `tools.annotate.${k}`)),
      },
    ],
  },
  {
    label: "menu.window.title",
    items: [item("window", "minimize"), item("window", "maximize")],
  },
  {
    label: "menu.help.title",
    items: [item("help", "shortcuts"), SEP, item("help", "checkUpdates"), item("help", "about")],
  },
];
