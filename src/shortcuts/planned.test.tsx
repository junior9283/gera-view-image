// Lote 0 (Fiação): os comandos dos lotes de paridade estão nos menus, os atalhos não colidem
// e, sem handler registrado, o comando fica desabilitado.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MenuBar } from "../chrome/MenuBar";
import { MENUS, type MenuItem } from "../chrome/menus";
import en from "../i18n/en.json";
import ptBR from "../i18n/pt-BR.json";
import { COMMAND_IDS, isEnabled, registerCommand, resetCommandsForTests, runCommand, type CommandId } from "./commands";
import { ALIASES, KEYMAP, matchShortcut } from "./keymap";
import { PLANNED, type PlannedCommand } from "./planned";

type Entry = Exclude<MenuItem, { separator: true }>;
const entries = (items: MenuItem[]): Entry[] =>
  items.flatMap((i) => ("separator" in i ? [] : i.submenu ? [i, ...entries(i.submenu)] : [i]));
const commandsOf = (items: MenuItem[]) => entries(items).flatMap((i) => (i.command ? [i.command] : []));
const menu = (label: string) => MENUS.find((m) => m.label === `menu.${label}.title`)!;
const get = (o: unknown, path: string) => path.split(".").reduce<unknown>((a, k) => (a as Record<string, unknown> | undefined)?.[k], o);
const planned = Object.keys(PLANNED) as PlannedCommand[];

type Mods = Partial<Record<"ctrlKey" | "shiftKey" | "altKey" | "metaKey", boolean>>;
const key = (k: string, mods: Mods = {}, code = "") => new KeyboardEvent("keydown", { key: k, code, ...mods });

beforeEach(() => resetCommandsForTests());
afterEach(cleanup);

describe("menus dos lotes de paridade", () => {
  it("todo comando planejado é um CommandId e aparece exatamente uma vez nos menus, com rótulo em pt-BR e en", () => {
    const all = MENUS.flatMap((m) => commandsOf(m.items));
    for (const id of planned) {
      expect(COMMAND_IDS).toContain(id);
      expect(all.filter((c) => c === id), id).toHaveLength(1);
    }
    for (const i of MENUS.flatMap((m) => entries(m.items))) {
      expect(typeof get(ptBR, i.label), i.label).toBe("string");
      expect(typeof get(en, i.label), i.label).toBe("string");
    }
  });

  it("todo CommandId está em algum menu", () => {
    const all = new Set(MENUS.flatMap((m) => commandsOf(m.items)));
    expect(COMMAND_IDS.filter((id) => !all.has(id))).toEqual([]);
  });

  it("Arquivo segue a ordem do Pré-Visualização", () => {
    expect(commandsOf(menu("file").items)).toEqual([
      "file.newFromClipboard", "file.open", "file.openRecent",
      "file.close", "file.closeAll", "file.closeWindow", "file.save", "file.duplicate", "file.saveAs", "file.rename",
      "file.moveTo", "file.moveToTrash", "file.tags", "file.lock", "file.showInFolder", "file.openWith",
      "file.revertLastSaved", "file.revertOriginal", "file.browseVersions",
      "file.export", "file.exportSelected", "file.exportPdf",
      "file.shareEmail", "file.shareDevice",
      "file.importScanner", "file.captureSelection", "file.captureWindow", "file.captureScreen",
      "file.print", "file.quit",
    ]);
  });

  it("submenus novos ficam nos menus certos", () => {
    const sub = (m: string, label: string) => entries(menu(m).items).find((i) => i.label === label)?.submenu;
    expect(commandsOf(sub("file", "menu.file.share") ?? [])).toEqual(["file.shareEmail", "file.shareDevice"]);
    expect(commandsOf(sub("edit", "menu.edit.findMenu") ?? [])).toEqual(["edit.find", "edit.findNext", "edit.findPrev"]);
    expect(commandsOf(sub("edit", "menu.edit.speech") ?? [])).toEqual(["edit.startSpeaking", "edit.stopSpeaking"]);
    expect(commandsOf(sub("view", "menu.view.sortBy") ?? [])).toEqual([
      "view.sortByName", "view.sortByDate", "view.sortByKind", "view.sortBySize",
    ]);
    expect(commandsOf(sub("tools", "menu.tools.liveTextMenu") ?? [])).toEqual([
      "tools.liveText", "tools.copyAllText", "tools.translateText", "tools.searchText", "tools.searchImageWeb",
    ]);
    expect(commandsOf(menu("go").items)).toEqual(["go.back", "go.forward", "go.prev", "go.next", "go.first", "go.last"]);
    expect(commandsOf(menu("help").items)[0]).toBe("help.search");
  });
});

describe("atalhos dos lotes de paridade", () => {
  const all = [
    ...Object.entries(KEYMAP),
    ...Object.entries(ALIASES).flatMap(([id, list]) => (list ?? []).map((s) => [id, s] as const)),
  ].filter(([, s]) => s);

  it("nenhum atalho se repete", () => {
    const combos = all.map(([, s]) => s);
    expect(combos.filter((s, i) => combos.indexOf(s) !== i)).toEqual([]);
  });

  it("nenhum atalho usa uma combinação que o desktop (GNOME/KDE) toma antes do app", () => {
    const reserved = ["Ctrl+Alt+T", "Ctrl+Alt+L", "Ctrl+Alt+D", "Ctrl+Alt+Delete", "Ctrl+Alt+Backspace", "Alt+Tab", "Alt+F4"];
    expect(all.filter(([, s]) => reserved.includes(s))).toEqual([]);
  });

  it("os atalhos novos chegam ao comando certo", () => {
    const cases: [KeyboardEvent, CommandId][] = [
      [key("w", { ctrlKey: true, altKey: true }, "KeyW"), "file.closeAll"],
      [key("W", { ctrlKey: true, shiftKey: true }, "KeyW"), "file.closeWindow"],
      [key("S", { ctrlKey: true, shiftKey: true, altKey: true }, "KeyS"), "file.saveAs"],
      [key("Backspace", { ctrlKey: true }, "Backspace"), "file.moveToTrash"],
      [key("f", { ctrlKey: true }, "KeyF"), "edit.find"],
      [key("g", { ctrlKey: true }, "KeyG"), "edit.findNext"],
      [key("G", { ctrlKey: true, shiftKey: true }, "KeyG"), "edit.findPrev"],
      [key("T", { ctrlKey: true, shiftKey: true }, "KeyT"), "view.toolbar"],
      [key("|", { ctrlKey: true, shiftKey: true }, "Backslash"), "view.allTabs"],
      [key("[", { ctrlKey: true }, "BracketLeft"), "go.back"],
      [key("]", { ctrlKey: true }, "BracketRight"), "go.forward"],
      [key("K", { ctrlKey: true, shiftKey: true }, "KeyK"), "tools.removeBackground"],
      [key("`", {}, "Backquote"), "tools.magnifier"],
      [key("C", { ctrlKey: true, shiftKey: true }, "KeyC"), "tools.showColors"],
      [key("t", { ctrlKey: true }, "KeyT"), "tools.showFonts"],
      [key("Tab", { ctrlKey: true }, "Tab"), "window.nextTab"],
      [key("Tab", { ctrlKey: true, shiftKey: true }, "Tab"), "window.prevTab"],
      [key("?", { ctrlKey: true, shiftKey: true }, "Slash"), "help.search"],
    ];
    for (const [e, id] of cases) expect(matchShortcut(e), id).toBe(id);
  });
});

describe("comando planejado sem handler", () => {
  it("fica desabilitado e não executa", () => {
    for (const id of planned) {
      expect(isEnabled(id), id).toBe(false);
      expect(runCommand(id), id).toBe(false);
    }
  });

  it("aparece desabilitado no menu, e habilita quando o lote registra o handler", () => {
    render(<MenuBar />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Arquivo" }));
    expect(screen.getByRole("menuitem", { name: /Salvar Como/ }).getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("menuitem", { name: /Compartilhar/ }).getAttribute("aria-disabled")).toBe("true");
    act(() => void registerCommand("file.saveAs", () => {}));
    expect(screen.getByRole("menuitem", { name: /Salvar Como/ }).getAttribute("aria-disabled")).toBe("false");
  });
});
