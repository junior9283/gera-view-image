import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { DocInfo } from "../ipc/types";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({}) }));

import "../i18n";
import { MenuBar } from "../chrome/MenuBar";
import { answerUnsaved, currentUnsaved, resetUnsavedForTests } from "../file/unsaved";
import { isEnabled, registerCommand, runCommand, subscribeCommands } from "../shortcuts/commands";
import { matchShortcut } from "../shortcuts/keymap";
import { resetDocsForTests, useDocs } from "../store/docs";
import { getPrefs, resetPrefsForTests, setPrefs } from "../store/prefs";
import { resetUiForTests, useUi } from "../store/ui";
import { TabsOverlays } from "./AllTabs";
import "./register";
import { resetTabsForTests, setVeil, useTabs } from "./store";
import { TabBar } from "./TabBar";

const info = (id: number, extra: Partial<DocInfo> = {}): DocInfo => ({
  id, path: `/p/${id}.png`, name: `${id}.png`, format: "png", width: 40, height: 30, frames: 1,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 0, error: null, ...extra,
});
const active = () => useDocs.getState().activeId;
const tabs = () => screen.getAllByRole("tab");
const selected = () => tabs().find((x) => x.getAttribute("aria-selected") === "true")!;

vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });

beforeEach(() => {
  invoke.mockReset().mockResolvedValue(undefined);
  resetDocsForTests();
  resetPrefsForTests();
  resetUiForTests();
  resetTabsForTests();
  resetUnsavedForTests();
  setPrefs({ language: "pt-BR" });
});
afterEach(cleanup);

describe("barra de abas", () => {
  const show = (...docs: DocInfo[]) => {
    useDocs.getState().add(docs);
    setPrefs({ tabBar: true });
    return render(<TabBar />);
  };

  it("só aparece com a preferência, documentos e fora da tela cheia", () => {
    render(<TabBar />);
    expect(screen.queryByRole("tablist")).toBeNull();
    act(() => useDocs.getState().add([info(1)]));
    expect(screen.queryByRole("tablist")).toBeNull();
    act(() => void runCommand("view.tabBar"));
    expect(getPrefs().tabBar).toBe(true);
    expect(screen.getByRole("tablist", { name: "Abas" })).toBeTruthy();
    act(() => useUi.setState({ fullscreen: true }));
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("uma aba por documento, com a ativa marcada e só ela no Tab", () => {
    show(info(1), info(2));
    expect(tabs().map((x) => x.textContent)).toEqual(["1.png", "2.png"]);
    expect(tabs().map((x) => [x.getAttribute("aria-selected"), x.tabIndex])).toEqual([["true", 0], ["false", -1]]);
    fireEvent.click(tabs()[1]);
    expect(active()).toBe(2);
  });

  it("setas, Home e End trocam de aba dando a volta, e o foco acompanha", () => {
    show(info(1), info(2), info(3));
    tabs()[0].focus();
    const press = (key: string) => fireEvent.keyDown(document.activeElement!, { key });
    press("ArrowLeft");
    expect(active()).toBe(3);
    expect(document.activeElement).toBe(selected());
    press("ArrowRight");
    expect(active()).toBe(1);
    press("End");
    expect(active()).toBe(3);
    press("Home");
    expect(active()).toBe(1);
    expect(document.activeElement).toBe(selected());
  });

  it("setas na barra não chegam aos atalhos do app", () => {
    show(info(1), info(2));
    const seen = vi.fn();
    window.addEventListener("keydown", seen);
    fireEvent.keyDown(tabs()[0], { key: "ArrowRight" });
    expect(seen).not.toHaveBeenCalled();
    fireEvent.keyDown(tabs()[0], { key: "Tab", ctrlKey: true });
    expect(seen).toHaveBeenCalledTimes(1);
    window.removeEventListener("keydown", seen);
  });

  it("botão, clique do meio e Delete fecham a aba, e o foco vai para a vizinha", async () => {
    show(info(1), info(2), info(3), info(4));
    fireEvent.click(screen.getByRole("button", { name: "Fechar 4.png" }));
    await vi.waitFor(() => expect(tabs()).toHaveLength(3));
    fireEvent(tabs()[2], new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    await vi.waitFor(() => expect(tabs()).toHaveLength(2));
    tabs()[0].focus();
    fireEvent.keyDown(tabs()[0], { key: "Delete" });
    await vi.waitFor(() => expect(tabs().map((x) => x.textContent)).toEqual(["2.png"]));
    await vi.waitFor(() => expect(document.activeElement).toBe(selected()));
  });

  it("fechar aba não salva pergunta e Cancelar mantém", async () => {
    show(info(1, { dirty: true }), info(2));
    expect(screen.getByRole("tab", { name: "1.png (alterações não salvas)" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Fechar 1.png" }));
    await vi.waitFor(() => expect(currentUnsaved()).not.toBeNull());
    answerUnsaved("cancel");
    await new Promise((r) => setTimeout(r, 0));
    expect(tabs()).toHaveLength(2);
  });

  it("o botão de nova aba abre o diálogo de arquivos", () => {
    const open = vi.fn();
    const off = registerCommand("file.open", open);
    show(info(1));
    fireEvent.click(screen.getByRole("button", { name: "Abrir em nova aba" }));
    expect(open).toHaveBeenCalled();
    off();
  });
});

describe("comandos", () => {
  it("Aba Anterior/Próxima dão a volta e só valem com mais de uma", () => {
    useDocs.getState().add([info(1)]);
    expect(isEnabled("window.nextTab")).toBe(false);
    useDocs.getState().add([info(2), info(3)]);
    runCommand("window.prevTab");
    expect(active()).toBe(3);
    runCommand("window.nextTab");
    expect(active()).toBe(1);
  });

  it("atalhos previstos nos menus", () => {
    const key = (k: string, o: KeyboardEventInit) => matchShortcut(new KeyboardEvent("keydown", { key: k, ctrlKey: true, ...o }));
    expect(key("Tab", {})).toBe("window.nextTab");
    expect(key("Tab", { shiftKey: true })).toBe("window.prevTab");
    expect(key("|", { shiftKey: true })).toBe("view.allTabs");
    expect(key("W", { shiftKey: true })).toBe("file.closeWindow");
  });

  it("os menus são avisados quando aparece outra janela", () => {
    const told = vi.fn();
    const off = subscribeCommands(told);
    useTabs.setState({ windows: [win("main", "a"), win("doc-1", "b")] });
    expect(told).toHaveBeenCalled();
    told.mockReset();
    useTabs.setState({ windows: [win("main", "outro título"), win("doc-1", "b")] });
    expect(told).not.toHaveBeenCalled();
    off();
  });

  it("Juntar só com outra janela; Mover só se sobrar aba; Scanner continua desabilitado", () => {
    expect(isEnabled("window.mergeAllWindows")).toBe(false);
    useTabs.setState({ windows: [win("main", "a"), win("doc-1", "b")] });
    expect(isEnabled("window.mergeAllWindows")).toBe(true);
    useDocs.getState().add([info(1)]);
    expect(isEnabled("window.moveTabToNewWindow")).toBe(false);
    useDocs.getState().add([info(2)]);
    expect(isEnabled("window.moveTabToNewWindow")).toBe(true);
    expect(isEnabled("file.importScanner")).toBe(false);
    expect(isEnabled("file.closeWindow")).toBe(true);
    expect(isEnabled("window.bringAllToFront")).toBe(true);
  });
});

const win = (label: string, title: string) => ({ label, title });

describe("menu Janela", () => {
  it("lista as janelas abertas, marca a atual e foca a escolhida", () => {
    useTabs.setState({ windows: [win("main", "praia.png"), win("doc-1", "gato.png")] });
    render(<MenuBar />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Janela" }));
    const list = screen.getAllByRole("menuitemradio");
    expect(list.map((x) => [x.textContent, x.getAttribute("aria-checked")])).toEqual([["praia.png", "true"], ["gato.png", "false"]]);
    fireEvent.click(list[1]);
    expect(invoke).toHaveBeenCalledWith("focus_window", { label: "doc-1" });
    expect(screen.queryByRole("menuitemradio")).toBeNull();
  });

  it("as setas alcançam as janelas e só esse menu as mostra", () => {
    useTabs.setState({ windows: [win("main", "praia.png")] });
    render(<MenuBar />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Janela" }));
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(screen.getByRole("menuitemradio"));
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(invoke).toHaveBeenCalledWith("focus_window", { label: "main" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Arquivo" }));
    expect(screen.queryByRole("menuitemradio")).toBeNull();
  });
});

describe("Mostrar Todas as Abas", () => {
  it("mostra todas, foca a ativa, escolher ativa e fecha", () => {
    useDocs.getState().add([info(1), info(2)]);
    useDocs.getState().setActive(2);
    render(<TabsOverlays />);
    act(() => void runCommand("view.allTabs"));
    const dialog = screen.getByRole("dialog", { name: "Todas as abas" });
    expect(document.activeElement?.textContent).toBe("2.png");
    fireEvent.click(within(dialog).getByRole("button", { name: "1.png" }));
    expect(active()).toBe(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("setas andam e Esc fecha", () => {
    useDocs.getState().add([info(1), info(2)]);
    render(<TabsOverlays />);
    act(() => void runCommand("view.allTabs"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement?.textContent).toBe("2.png");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(active()).toBe(1);
  });

  it("fechar a última encerra a visão", async () => {
    useDocs.getState().add([info(1)]);
    render(<TabsOverlays />);
    act(() => void runCommand("view.allTabs"));
    fireEvent.click(screen.getByRole("button", { name: "Fechar 1.png" }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("o véu bloqueia os atalhos enquanto move ou fecha", () => {
    render(<TabsOverlays />);
    act(() => setVeil("moving"));
    expect(document.querySelector('[aria-modal="true"]')?.getAttribute("aria-busy")).toBe("true");
    act(() => setVeil(null));
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  });
});
