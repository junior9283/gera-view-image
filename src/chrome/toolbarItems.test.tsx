// Itens opcionais da barra (Remover Fundo, Seleção, Cores e Fontes) e o botão pressionado das alternâncias.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMarkupForTests, useMarkup } from "../markup/store";
import { registerCommand, resetCommandsForTests } from "../shortcuts/commands";
import { resetPrefsForTests, setPrefs } from "../store/prefs";
import { useSelection } from "../store/selection";
import { resetUiForTests, useUi } from "../store/ui";
import { Toolbar } from "./Toolbar";
import { DEFAULT_TOOLBAR, TOOLBAR_ITEMS } from "./toolbarItems";

beforeEach(() => {
  resetCommandsForTests();
  resetPrefsForTests();
  resetMarkupForTests();
  resetUiForTests();
  useSelection.setState({ selectionTool: null });
  setPrefs({ language: "pt-BR", toolbarItems: ["selection", "removeBackground", "colors", "fonts"] });
});
afterEach(cleanup);

describe("itens opcionais", () => {
  it("existem na paleta e não entram no conjunto padrão", () => {
    const ids = TOOLBAR_ITEMS.map((i) => i.id);
    for (const id of ["selection", "removeBackground", "colors", "fonts"]) {
      expect(ids).toContain(id);
      expect(DEFAULT_TOOLBAR).not.toContain(id);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("Remover Fundo, Cores e Fontes executam os comandos", () => {
    const run = vi.fn();
    for (const id of ["tools.removeBackground", "tools.showColors", "tools.showFonts"] as const) registerCommand(id, () => run(id));
    render(<Toolbar />);
    for (const name of ["Remover Fundo", "Cores", "Fontes"]) fireEvent.click(screen.getByRole("button", { name }));
    expect(run.mock.calls.flat()).toEqual(["tools.removeBackground", "tools.showColors", "tools.showFonts"]);
  });

  it("Seleção abre o menu de ferramentas; escolher liga, escolher de novo desliga", () => {
    registerCommand("view.actualSize", () => {});
    useMarkup.setState({ tool: "draw" });
    render(<Toolbar />);
    const pick = () => {
      fireEvent.click(screen.getByRole("button", { name: "Seleção" }));
      fireEvent.click(screen.getByRole("menuitemradio", { name: /Laço$/ }));
    };
    pick();
    expect(useSelection.getState().selectionTool).toBe("lasso");
    expect(useMarkup.getState().tool).toBe("select");
    fireEvent.click(screen.getByRole("button", { name: "Seleção" }));
    expect(screen.getAllByRole("menuitemradio").map((i) => i.getAttribute("aria-checked"))).toEqual(["false", "false", "true", "false"]);
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Laço$/ }));
    expect(useSelection.getState().selectionTool).toBeNull();
  });

  it("sem imagem, as ferramentas de seleção ficam desabilitadas", () => {
    registerCommand("view.actualSize", () => {}, () => false);
    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "Seleção" }));
    expect(screen.getAllByRole("menuitemradio").every((i) => i.getAttribute("aria-disabled") === "true")).toBe(true);
  });
});

describe("alternâncias", () => {
  it("o botão da barra lateral e o da Marcação mostram se estão ligados", () => {
    setPrefs({ toolbarItems: null });
    for (const id of ["view.thumbnails", "view.markupBar"] as const) registerCommand(id, () => {});
    render(<Toolbar />);
    const pressed = (name: RegExp) => screen.getByRole("button", { name }).getAttribute("aria-pressed");
    expect(pressed(/barra lateral/)).toBe("false");
    act(() => useUi.getState().setSidebar("thumbs"));
    expect(pressed(/barra lateral/)).toBe("true");
    act(() => useMarkup.getState().setVisible(true));
    expect(pressed(/barra de marcação/)).toBe("true");
    expect(screen.getByRole("button", { name: "Reduzir" }).hasAttribute("aria-pressed")).toBe(false);
  });
});
