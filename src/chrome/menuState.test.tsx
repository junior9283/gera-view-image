// L11: itens de alternância com o rótulo ou o ✓ do estado atual.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { COMMAND_IDS, registerCommand, resetCommandsForTests, type CommandId } from "../shortcuts/commands";
import { commandState } from "../shortcuts/commandState";
import { resetInspectorForTests, setInspectorOpen } from "../inspector/toggle";
import { resetMarkupForTests, useMarkup } from "../markup/store";
import { useDocs } from "../store/docs";
import { resetPrefsForTests, setPrefs } from "../store/prefs";
import { resetUiForTests, useUi } from "../store/ui";
import { resetMagnifierForTests, toggleMagnifier } from "../viewer/Magnifier";
import { MenuBar } from "./MenuBar";
import { resetToastsForTests } from "./notify";

const openMenu = (name: string) => fireEvent.click(screen.getByRole("menuitem", { name }));

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
