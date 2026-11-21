import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCommand, resetCommandsForTests } from "../shortcuts/commands";
import { IMAGE_MENU, ImageContextMenu } from "./ContextMenu";

const host = () =>
  render(
    <div className="viewport" data-testid="viewport">
      <div className="viewport-overlay">
        <ImageContextMenu />
      </div>
    </div>,
  );
const menu = () => screen.queryByRole("menu", { name: "Menu de contexto da imagem" });
const entry = (name: string) => within(menu()!).getByText(name).closest("li")!;

describe("menu de contexto da imagem", () => {
  beforeEach(() => resetCommandsForTests());
  afterEach(cleanup);

  it("tem os itens do Pré-Visualização: Copiar, Colar, Copiar Objeto, Girar, Compartilhar e Abrir com", () => {
    const flat = IMAGE_MENU.flatMap((i) => ("separator" in i ? [] : i.submenu ? i.submenu : [i]));
    const ids = flat.flatMap((i) => ("command" in i && i.command ? [i.command] : []));
    expect(ids).toEqual(expect.arrayContaining([
      "edit.copy", "edit.paste", "tools.copySubject", "tools.rotateLeft", "tools.rotateRight",
      "file.shareEmail", "file.openWith",
    ]));
  });

  it("botão direito na imagem abre no ponteiro; o item executa o comando e fecha", () => {
    const copy = vi.fn();
    registerCommand("edit.copy", copy);
    host();
    expect(menu()).toBeNull();
    const ev = fireEvent.contextMenu(screen.getByTestId("viewport"), { clientX: 40, clientY: 50 });
    expect(ev).toBe(false); // preventDefault: sem o menu do WebKit
    expect(entry("Copiar").getAttribute("aria-disabled")).toBe("false");
    expect(entry("Girar à Esquerda").getAttribute("aria-disabled")).toBe("true"); // sem handler
    fireEvent.click(entry("Copiar"));
    expect(copy).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
  });

  it("Esc ou clique fora fecham sem executar", () => {
    const copy = vi.fn();
    registerCommand("edit.copy", copy);
    host();
    fireEvent.contextMenu(screen.getByTestId("viewport"), { clientX: 10, clientY: 10 });
    fireEvent.keyDown(menu()!, { key: "Escape" });
    expect(menu()).toBeNull();
    fireEvent.contextMenu(screen.getByTestId("viewport"), { clientX: 10, clientY: 10 });
    fireEvent.mouseDown(screen.getByTestId("context-backdrop"));
    expect(menu()).toBeNull();
    expect(copy).not.toHaveBeenCalled();
  });
});
