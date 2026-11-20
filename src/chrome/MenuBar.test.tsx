import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../i18n/en.json";
import ptBR from "../i18n/pt-BR.json";
import { COMMAND_IDS, registerCommand, resetCommandsForTests } from "../shortcuts/commands";
import { MenuBar } from "./MenuBar";
import { MENUS, type MenuItem } from "./menus";

const flat = (items: MenuItem[]): MenuItem[] => items.flatMap((i) => ("submenu" in i && i.submenu ? [i, ...flat(i.submenu)] : [i]));
const get = (o: unknown, path: string) => path.split(".").reduce<unknown>((a, k) => (a as Record<string, unknown> | undefined)?.[k], o);

const altTap = () => {
  fireEvent.keyDown(window, { key: "Alt", altKey: true });
  fireEvent.keyUp(window, { key: "Alt" });
};

beforeEach(() => resetCommandsForTests());
afterEach(cleanup);

describe("menus declarativos", () => {
  it("todo rótulo existe em pt-BR e en; todo comando é um CommandId", () => {
    const items = MENUS.flatMap((m) => flat(m.items));
    const labels = [...MENUS.map((m) => m.label), ...items.flatMap((i) => ("label" in i ? [i.label] : []))];
    for (const l of labels) {
      expect(typeof get(ptBR, l), l).toBe("string");
      expect(typeof get(en, l), l).toBe("string");
    }
    for (const i of items) if ("command" in i && i.command) expect(COMMAND_IDS).toContain(i.command);
  });

  it("tem os sete menus do Preview na ordem", () => {
    expect(MENUS.map((m) => m.label)).toEqual([
      "menu.file.title", "menu.edit.title", "menu.view.title", "menu.go.title", "menu.tools.title", "menu.window.title", "menu.help.title",
    ]);
  });
});

describe("MenuBar", () => {
  it("clique abre o menu; item sem comando registrado fica desabilitado; item habilitado executa e fecha", () => {
    const undo = vi.fn();
    registerCommand("edit.undo", undo);
    render(<MenuBar />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Editar" }));
    const paste = screen.getByRole("menuitem", { name: /Colar/ });
    expect(paste.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(paste);
    expect(screen.getByRole("menu")).toBeTruthy();
    const item = screen.getByRole("menuitem", { name: /Desfazer/ });
    expect(item.textContent).toContain("Ctrl+Z");
    fireEvent.click(item);
    expect(undo).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Alt abre o primeiro menu, setas navegam, Enter executa", () => {
    const run = vi.fn();
    registerCommand("edit.redo", run);
    registerCommand("edit.undo", () => {});
    render(<MenuBar />);
    altTap();
    expect(screen.getByRole("menu").getAttribute("aria-label")).toBe("Arquivo");
    expect(document.activeElement?.getAttribute("role")).toBe("menuitem");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(screen.getByRole("menu").getAttribute("aria-label")).toBe("Editar");
    expect(document.activeElement?.textContent).toContain("Desfazer");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toContain("Refazer");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement?.textContent).toContain("Preferências");
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Esc fecha e devolve o foco ao app", () => {
    render(
      <>
        <button>app</button>
        <MenuBar />
      </>,
    );
    const app = screen.getByRole("button", { name: "app" });
    app.focus();
    altTap();
    expect(document.activeElement).not.toBe(app);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(app);
  });

  it("Alt com outra tecla (Alt+Tab, Ctrl+Alt+1) não abre o menu", () => {
    render(<MenuBar />);
    fireEvent.keyDown(window, { key: "Alt", altKey: true });
    fireEvent.keyDown(window, { key: "1", altKey: true, ctrlKey: true });
    fireEvent.keyUp(window, { key: "Alt" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("submenu Anotar fica desabilitado até a Marcação registrar comandos", () => {
    render(<MenuBar />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Ferramentas" }));
    expect(screen.getByRole("menuitem", { name: /Anotar/ }).getAttribute("aria-disabled")).toBe("true");
    act(() => void registerCommand("tools.annotate.arrow", () => {}));
    const annotate = screen.getByRole("menuitem", { name: /Anotar/ });
    expect(annotate.getAttribute("aria-disabled")).toBe("false");
    fireEvent.keyDown(annotate, { key: "ArrowRight" });
    expect(screen.getAllByRole("menu")).toHaveLength(2);
    expect(screen.getByRole("menuitem", { name: "Seta" }).getAttribute("aria-disabled")).toBe("false");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(screen.getAllByRole("menu")).toHaveLength(1);
  });

  it("clique fora fecha", () => {
    render(<MenuBar />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Ir" }));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
