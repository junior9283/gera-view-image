// L10 e L11: Abrir Recente como submenu, e itens de alternância com o rótulo ou o ✓ do estado atual.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const open = vi.hoisted(() => ({ openHere: vi.fn<(p: string[]) => Promise<unknown[]>>(async () => []) }));
vi.mock("../tabs/open", () => open);

import * as ipc from "../ipc/commands";
import { openRecent } from "../file/fileActions";
import type { DocInfo } from "../ipc/types";
import { OPEN_RECENT_EVENT } from "../shortcuts/events";
import { COMMAND_IDS, registerCommand, resetCommandsForTests, type CommandId } from "../shortcuts/commands";
import { commandState } from "../shortcuts/commandState";
import { resetInspectorForTests, setInspectorOpen } from "../inspector/toggle";
import { resetMarkupForTests, useMarkup } from "../markup/store";
import { useDocs } from "../store/docs";
import { getPrefs, MAX_RECENT, resetPrefsForTests, setPrefs } from "../store/prefs";
import { resetUiForTests, useUi } from "../store/ui";
import { resetMagnifierForTests, toggleMagnifier } from "../viewer/Magnifier";
import { MenuBar } from "./MenuBar";
import { getToasts, resetToastsForTests } from "./notify";

const info: DocInfo = {
  id: 3, path: "/fotos/Férias/Praia.jpg", name: "Praia.jpg", format: "jpeg", width: 4, height: 2, frames: 1,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 0, error: null,
};
const openMenu = (name: string) => fireEvent.click(screen.getByRole("menuitem", { name }));
const recentItem = () => screen.getByRole("menuitem", { name: "Abrir Recente" });

beforeEach(() => {
  vi.clearAllMocks();
  resetCommandsForTests();
  resetPrefsForTests();
  setPrefs({ language: "pt-BR" });
  resetUiForTests();
  resetMarkupForTests();
  resetMagnifierForTests();
  resetInspectorForTests();
  resetToastsForTests();
  useDocs.setState({ docs: [], activeId: null });
  for (const id of COMMAND_IDS) registerCommand(id, () => {});
});
afterEach(cleanup);

describe("Arquivo › Abrir Recente", () => {
  it("é um submenu com os arquivos, do mais novo ao mais antigo, e Limpar Menu no fim", () => {
    setPrefs({ recent: ["/fotos/Férias/Praia.jpg", "/a/Ação.png"] });
    render(<MenuBar />);
    openMenu("Arquivo");
    expect(recentItem().getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.mouseEnter(recentItem());
    const items = [...screen.getByRole("menu", { name: "Abrir Recente" }).querySelectorAll('[role="menuitem"]')];
    expect(items.map((i) => i.textContent)).toEqual(["Praia.jpg", "Ação.png", "Limpar Menu"]);
    expect(items[0].getAttribute("title")).toBe("/fotos/Férias/Praia.jpg");
  });

  it("nomes repetidos mostram a pasta", () => {
    setPrefs({ recent: ["/a/foto.jpg", "/b/Viagem à Serra/foto.jpg", "/c/outra.jpg"] });
    render(<MenuBar />);
    openMenu("Arquivo");
    fireEvent.mouseEnter(recentItem());
    const items = [...screen.getByRole("menu", { name: "Abrir Recente" }).querySelectorAll('[role="menuitem"]')];
    expect(items.map((i) => i.textContent)).toEqual(["foto.jpg — a", "foto.jpg — Viagem à Serra", "outra.jpg", "Limpar Menu"]);
  });

  it("pelo teclado: seta à direita entra, Enter abre o arquivo", async () => {
    open.openHere.mockResolvedValue([info]);
    setPrefs({ recent: [info.path] });
    render(<MenuBar />);
    openMenu("Arquivo");
    recentItem().focus();
    fireEvent.keyDown(recentItem(), { key: "ArrowRight" });
    expect(document.activeElement?.textContent).toBe("Praia.jpg");
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(open.openHere).toHaveBeenCalledWith([info.path]));
  });

  it("Limpar Menu esvazia a lista, e o submenu fica desabilitado", () => {
    setPrefs({ recent: ["/a/b.jpg"] });
    render(<MenuBar />);
    openMenu("Arquivo");
    fireEvent.mouseEnter(recentItem());
    fireEvent.click(screen.getByRole("menuitem", { name: "Limpar Menu" }));
    expect(getPrefs().recent).toEqual([]);
    openMenu("Arquivo");
    expect(recentItem().getAttribute("aria-disabled")).toBe("true");
  });

  it("Arquivo › Abrir Recente (pelo comando, como na Ajuda › Pesquisar) abre o menu Arquivo já no submenu", () => {
    setPrefs({ recent: ["/a/b.jpg"] });
    render(<MenuBar />);
    act(() => void window.dispatchEvent(new Event(OPEN_RECENT_EVENT)));
    expect(screen.getAllByRole("menu")).toHaveLength(2);
    expect(document.activeElement?.textContent).toBe("b.jpg");
  });

  it("arquivo que não existe mais: avisa, sai da lista e não deixa aba com erro", async () => {
    const missing = { ...info, error: "not_found" as const };
    setPrefs({ recent: [info.path, "/a/b.jpg"] });
    useDocs.setState({ docs: [missing], activeId: 3 });
    open.openHere.mockResolvedValue([missing]);
    const close = vi.spyOn(ipc, "closeDocument").mockResolvedValue(undefined);
    await act(() => openRecent(info.path));
    expect(close).toHaveBeenCalledWith(3);
    expect(useDocs.getState().docs).toEqual([]);
    expect(getPrefs().recent).toEqual(["/a/b.jpg"]);
    expect(getToasts().map((t) => t.text)).toEqual(["“Praia.jpg” não foi encontrado e saiu dos recentes."]);
    close.mockRestore();
  });

  it("a lista cheia cabe no teto", () => {
    setPrefs({ recent: Array.from({ length: 30 }, (_, i) => `/a/${i}.jpg`) });
    render(<MenuBar />);
    openMenu("Arquivo");
    fireEvent.mouseEnter(recentItem());
    expect(screen.getByRole("menu", { name: "Abrir Recente" }).querySelectorAll('[role="menuitem"]')).toHaveLength(MAX_RECENT + 1);
  });
});

describe("itens de alternância", () => {
  it.each<[string, string, string, () => void]>([
    ["Visualizar", "Mostrar Barra de Marcação", "Ocultar Barra de Marcação", () => useMarkup.getState().setVisible(true)],
    ["Visualizar", "Ocultar Barra de Ferramentas", "Mostrar Barra de Ferramentas", () => setPrefs({ toolbarHidden: true })],
    ["Visualizar", "Ocultar Fundo da Imagem", "Mostrar Fundo da Imagem", () => setPrefs({ showImageBackground: false })],
    ["Visualizar", "Mostrar Barra de Abas", "Ocultar Barra de Abas", () => setPrefs({ tabBar: true })],
    ["Visualizar", "Entrar em Tela Cheia", "Sair da Tela Cheia", () => useUi.setState({ fullscreen: true })],
    ["Ferramentas", "Mostrar Inspetor", "Ocultar Inspetor", () => setInspectorOpen(true)],
    ["Ferramentas", "Mostrar Lupa", "Ocultar Lupa", () => toggleMagnifier()],
    ["Ferramentas", "Mostrar Cores", "Ocultar Cores", () => useMarkup.setState({ visible: true, menu: "colors" })],
    ["Ferramentas", "Mostrar Fontes", "Ocultar Fontes", () => useMarkup.setState({ visible: true, menu: "fonts" })],
    ["Ferramentas", "Mostrar Inspetor de Marcação", "Ocultar Inspetor de Marcação", () => useMarkup.setState({ visible: true, menu: "properties" })],
  ])("%s: “%s” vira “%s”", (menu, before, after, change) => {
    render(<MenuBar />);
    openMenu(menu);
    const label = (text: string) => screen.queryAllByText(text, { selector: ".menu-label" });
    expect(label(before)).toHaveLength(1);
    expect(label(after)).toHaveLength(0);
    act(change);
    expect(label(before)).toHaveLength(0);
    expect(label(after)).toHaveLength(1);
  });

  it("Texto ao Vivo acompanha a preferência", () => {
    expect(commandState("tools.liveText").label).toBe("menu.tools.liveTextHide");
    setPrefs({ liveText: false });
    expect(commandState("tools.liveText").label).toBeUndefined();
  });

  it("barra lateral: ✓ no modo atual (escolha única)", () => {
    render(<MenuBar />);
    openMenu("Visualizar");
    const checked = () => screen.getAllByRole("menuitemradio").filter((i) => i.getAttribute("aria-checked") === "true").map((i) => i.querySelector(".menu-label")!.textContent);
    expect(checked()).toEqual(["Ocultar Barra Lateral"]);
    act(() => useUi.getState().setSidebar("thumbs"));
    expect(checked()).toEqual(["Miniaturas"]);
    act(() => useUi.getState().setSidebar("contact"));
    expect(checked()).toEqual(["Folha de Contatos"]);
  });

  it("Ordenar Por: ✓ na ordem atual, nenhum na manual", () => {
    const ids: CommandId[] = ["view.sortByName", "view.sortByDate", "view.sortByKind", "view.sortBySize"];
    const on = () => ids.filter((id) => commandState(id).checked);
    expect(on()).toEqual([]);
    setPrefs({ sortBy: "date" });
    expect(on()).toEqual(["view.sortByDate"]);
  });
});
