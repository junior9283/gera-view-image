import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCommand, resetCommandsForTests, type CommandId } from "../shortcuts/commands";
import { SHOW_SHORTCUTS_EVENT } from "../shortcuts/events";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { Toolbar } from "./Toolbar";

beforeEach(() => resetCommandsForTests());
afterEach(cleanup);

const spy = (id: CommandId, enabled?: () => boolean) => {
  const f = vi.fn();
  registerCommand(id, f, enabled);
  return f;
};

describe("Toolbar", () => {
  it("botões executam os comandos e ficam desabilitados sem registro", () => {
    const zin = spy("view.zoomIn");
    const side = spy("view.thumbnails");
    const insp = spy("tools.inspector");
    const markup = spy("view.markupBar");
    render(<Toolbar />);
    expect((screen.getByRole("button", { name: "Reduzir" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Ampliar" }));
    fireEvent.click(screen.getByRole("button", { name: "Mostrar ou ocultar a barra lateral" }));
    fireEvent.click(screen.getByRole("button", { name: "Mostrar inspetor" }));
    fireEvent.click(screen.getByRole("button", { name: "Mostrar barra de marcação" }));
    for (const f of [zin, side, insp, markup]) expect(f).toHaveBeenCalledTimes(1);
  });

  it("girar: clique à esquerda, Alt+clique à direita", () => {
    const left = spy("tools.rotateLeft");
    const right = spy("tools.rotateRight");
    render(<Toolbar />);
    const b = screen.getByRole("button", { name: /Girar à esquerda/ });
    fireEvent.click(b);
    fireEvent.click(b, { altKey: true });
    expect(left).toHaveBeenCalledTimes(1);
    expect(right).toHaveBeenCalledTimes(1);
  });

  it("habilitação acompanha o registro", () => {
    render(<Toolbar />);
    const b = screen.getByRole("button", { name: "Ampliar" }) as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    act(() => void registerCommand("view.zoomIn", () => {}));
    expect(b.disabled).toBe(false);
  });

  it("compartilhar abre Exportar…/Copiar/Abrir com…; Esc fecha", () => {
    const copy = spy("edit.copy");
    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "Compartilhar" }));
    expect(screen.getByRole("menuitem", { name: /Exportar/ }).getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("menuitem", { name: /Abrir com/ }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByRole("menuitem", { name: /Copiar/ }));
    expect(copy).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Compartilhar" }));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("ShortcutsDialog", () => {
  it("abre pelo evento, lista comandos com atalho e fecha com Esc", () => {
    render(<ShortcutsDialog />);
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => void window.dispatchEvent(new Event(SHOW_SHORTCUTS_EVENT)));
    const dlg = screen.getByRole("dialog");
    expect(dlg.textContent).toContain("Ctrl+K");
    expect(dlg.textContent).toContain("Mostrar Barra de Marcação");
    fireEvent.keyDown(dlg, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
