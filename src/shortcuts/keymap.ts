// Fonte única dos atalhos (os do Preview com Cmd→Ctrl). Formato: "Ctrl+Shift+Alt+Meta+Tecla".
import type { CommandId } from "./commands";

export { registerCommand, type CommandId } from "./commands";

/** Atalho principal de cada comando (mostrado nos menus); "" = sem atalho. */
export const KEYMAP: Record<CommandId, string> = {
  "file.newFromClipboard": "Ctrl+N",
  "file.open": "Ctrl+O",
  "file.openRecent": "",
  "file.close": "Ctrl+W",
  "file.save": "Ctrl+S",
  "file.duplicate": "Ctrl+Shift+S",
  "file.rename": "",
  "file.moveTo": "",
  "file.showInFolder": "",
  "file.revertLastSaved": "",
  "file.revertOriginal": "",
  "file.export": "",
  "file.exportSelected": "",
  "file.captureSelection": "",
  "file.captureWindow": "",
  "file.captureScreen": "",
  "file.print": "Ctrl+P",
  "file.openWith": "",
  "file.quit": "Ctrl+Q",
  // Lotes de paridade (ver `planned.ts`): o atalho só age quando o lote registrar o comando.
  "file.closeAll": "Ctrl+Alt+W",
  "file.closeWindow": "Ctrl+Shift+W",
  "file.saveAs": "Ctrl+Shift+Alt+S",
  "file.moveToTrash": "Ctrl+Backspace",
  "file.tags": "",
  "file.lock": "",
  "file.browseVersions": "",
  "file.exportPdf": "",
  "file.shareEmail": "",
  "file.shareDevice": "",
  "file.importScanner": "",
  "edit.undo": "Ctrl+Z",
  "edit.redo": "Ctrl+Shift+Z",
  "edit.cut": "Ctrl+X",
  "edit.copy": "Ctrl+C",
  "edit.paste": "Ctrl+V",
  "edit.duplicate": "Ctrl+D",
  "edit.delete": "Delete",
  "edit.selectAll": "Ctrl+A",
  "edit.deselect": "Escape",
  "edit.invertSelection": "Ctrl+Shift+I",
  "edit.preferences": "Ctrl+,",
  "edit.find": "Ctrl+F",
  "edit.findNext": "Ctrl+G",
  "edit.findPrev": "Ctrl+Shift+G",
  "edit.startSpeaking": "",
  "edit.stopSpeaking": "",
  "view.hideSidebar": "Ctrl+Alt+1",
  "view.thumbnails": "Ctrl+Alt+2",
  "view.contactSheet": "Ctrl+Alt+3",
  "view.actualSize": "Ctrl+0",
  "view.fit": "Ctrl+9",
  "view.zoomIn": "Ctrl+=",
  "view.zoomOut": "Ctrl+-",
  "view.zoomToSelection": "Ctrl+*",
  // No Preview é Cmd+Shift+A, mas Ctrl+Shift+A conflita com convenções do Linux.
  "view.markupBar": "Ctrl+Shift+M",
  "view.slideshow": "Ctrl+Shift+F",
  "view.fullscreen": "F11",
  "view.sortByName": "",
  "view.sortByDate": "",
  "view.sortByKind": "",
  "view.sortBySize": "",
  // No Preview é Cmd+Alt+T, mas Ctrl+Alt+T abre o terminal no GNOME e no KDE (o compositor fica com ele).
  "view.toolbar": "Ctrl+Shift+T",
  "view.customizeToolbar": "",
  "view.imageBackground": "",
  "view.softProofNone": "",
  "view.softProofChoose": "",
  "view.tabBar": "",
  // Cmd+Shift+\ no Preview: com Shift, a tecla "\" chega como "|" (US e ABNT2).
  "view.allTabs": "Ctrl+|",
  "go.prev": "ArrowLeft",
  "go.next": "ArrowRight",
  "go.first": "Home",
  "go.last": "End",
  "go.back": "Ctrl+[",
  "go.forward": "Ctrl+]",
  "tools.rotateLeft": "Ctrl+L",
  "tools.rotateRight": "Ctrl+R",
  "tools.flipH": "",
  "tools.flipV": "",
  "tools.crop": "Ctrl+K",
  "tools.adjustColor": "Ctrl+Alt+C",
  "tools.resize": "",
  "tools.selectRect": "",
  "tools.selectEllipse": "",
  "tools.selectLasso": "",
  "tools.selectSmartLasso": "",
  "tools.instantAlpha": "",
  "tools.inspector": "Ctrl+I",
  "tools.annotate.rect": "",
  "tools.annotate.oval": "",
  "tools.annotate.line": "",
  "tools.annotate.arrow": "",
  "tools.annotate.text": "",
  "tools.annotate.bubble": "",
  "tools.annotate.star": "",
  "tools.annotate.polygon": "",
  "tools.annotate.loupe": "",
  "tools.annotate.highlight": "",
  "tools.annotate.signature": "",
  "tools.assignProfile": "",
  "tools.removeBackground": "Ctrl+Shift+K",
  "tools.copySubject": "",
  "tools.magnifier": "`",
  "tools.showColors": "Ctrl+Shift+C",
  "tools.showFonts": "Ctrl+T",
  "tools.markupInspector": "",
  "tools.imageDescription": "",
  "tools.liveText": "",
  "tools.copyAllText": "",
  "tools.translateText": "",
  "tools.searchText": "",
  "tools.searchImageWeb": "",
  "window.minimize": "Ctrl+M",
  "window.maximize": "",
  "window.prevTab": "Ctrl+Shift+Tab",
  "window.nextTab": "Ctrl+Tab",
  "window.moveTabToNewWindow": "",
  "window.mergeAllWindows": "",
  "window.bringAllToFront": "",
  // Cmd+Shift+/ no Preview: com Shift, a tecla "/" chega como "?".
  "help.search": "Ctrl+?",
  "help.shortcuts": "",
  "help.checkUpdates": "",
  "help.about": "",
};

/** Atalhos alternativos (não aparecem no menu). */
export const ALIASES: Partial<Record<CommandId, string[]>> = {
  // Setas verticais: como na barra lateral do Pré-Visualização.
  "go.next": ["PageDown", "ArrowDown"],
  "go.prev": ["PageUp", "ArrowUp"],
  "view.zoomIn": ["Ctrl++"],
  "view.fullscreen": ["Ctrl+Meta+F"],
  "edit.delete": ["Backspace"],
  "file.moveToTrash": ["Ctrl+Delete"],
};

const MODIFIERS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph", "OS"]);

/** Letra de outro alfabeto (cirílico, grego, hebraico…): o atalho vem da posição física. */
const NON_LATIN_LETTER = /^(?=\p{L})\P{Script=Latin}$/u;

/** Nome da tecla: letras em maiúsculas. Com Ctrl/Alt (Alt muda o caractere em alguns layouts; o
 *  numérico sem NumLock manda "Insert"), o dígito vem do código físico. Sem modificador, o numérico
 *  sem NumLock fica com a tecla lógica (setas, Home, PageUp…). Shift+8 continua sendo "*".
 *  Em layouts não latinos, a letra vem do código físico (KeyA → A); nos latinos (ABNT2, AZERTY)
 *  vale a tecla lógica. */
function keyName(e: KeyboardEvent): string {
  const digit = /^(?:Digit|Numpad)(\d)$/.exec(e.code);
  if (digit && (e.altKey || (e.ctrlKey && e.key.length > 1))) return digit[1];
  const letter = /^Key([A-Z])$/.exec(e.code);
  if (letter && NON_LATIN_LETTER.test(e.key)) return letter[1];
  return e.key.length === 1 ? e.key.toUpperCase() : e.key;
}

/** Combinação normalizada do evento; `null` para tecla modificadora sozinha. */
export function comboOf(e: KeyboardEvent): string | null {
  if (MODIFIERS.has(e.key)) return null;
  const k = keyName(e);
  // Símbolos que já exigem Shift ("+", "*") não repetem o Shift na combinação.
  const symbol = k.length === 1 && !/[A-Z0-9]/.test(k);
  const parts = [e.ctrlKey && "Ctrl", e.shiftKey && !symbol && "Shift", e.altKey && "Alt", e.metaKey && "Meta", k];
  return parts.filter(Boolean).join("+");
}

const BY_COMBO = new Map<string, CommandId>();
for (const [id, s] of Object.entries(KEYMAP) as [CommandId, string][]) if (s) BY_COMBO.set(s, id);
for (const [id, list] of Object.entries(ALIASES) as [CommandId, string[]][]) for (const s of list) BY_COMBO.set(s, id);

/** Passo de cada seta, para mover seleções e anotações. */
export const ARROWS: Record<string, [number, number] | undefined> = {
  ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
};

/** Campo de texto: os atalhos ficam com ele (Ctrl+A, setas, Ctrl+Z…). */
export const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

export function matchShortcut(e: KeyboardEvent): CommandId | null {
  if (isTyping(e.target)) return null;
  const c = comboOf(e);
  return c ? (BY_COMBO.get(c) ?? null) : null;
}

const SYMBOLS: Record<string, string> = { ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Escape: "Esc", Delete: "Del" };

/** Texto do atalho para os menus. */
export const formatShortcut = (s: string): string => s.replace(/[^+]+$/, (k) => SYMBOLS[k] ?? k);
