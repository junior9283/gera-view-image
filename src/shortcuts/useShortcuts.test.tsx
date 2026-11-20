import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCommand, resetCommandsForTests } from "./commands";
import { useShortcuts } from "./useShortcuts";

function Host() {
  useShortcuts();
  return null;
}

const press = (key: string, mods: KeyboardEventInit = {}, target: EventTarget = window) => {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods });
  target.dispatchEvent(e);
  return e;
};

beforeEach(() => resetCommandsForTests());
afterEach(cleanup);

describe("useShortcuts", () => {
  it("executa o comando registrado e consome a tecla", () => {
    const run = vi.fn();
    registerCommand("tools.crop", run);
    render(<Host />);
    const e = press("k", { ctrlKey: true, code: "KeyK" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it("não executa comando desabilitado nem dentro de input de texto", () => {
    const crop = vi.fn();
    const all = vi.fn();
    registerCommand("tools.crop", crop, () => false);
    registerCommand("edit.selectAll", all);
    render(<Host />);
    press("k", { ctrlKey: true, code: "KeyK" });
    const input = document.createElement("input");
    document.body.append(input);
    press("a", { ctrlKey: true, code: "KeyA" }, input);
    input.remove();
    expect(crop).not.toHaveBeenCalled();
    expect(all).not.toHaveBeenCalled();
  });

  it("dentro de um diálogo modal os atalhos globais não agem (Esc é do diálogo)", () => {
    const run = vi.fn();
    registerCommand("edit.deselect", run);
    render(<Host />);
    const dlg = document.createElement("div");
    dlg.setAttribute("aria-modal", "true");
    const btn = document.createElement("button");
    dlg.append(btn);
    document.body.append(dlg);
    press("Escape", {}, btn);
    dlg.remove();
    expect(run).not.toHaveBeenCalled();
  });

  it("modal aberto com o foco fora dele (body) também bloqueia os atalhos", () => {
    const run = vi.fn();
    registerCommand("go.next", run);
    render(<Host />);
    const dlg = document.createElement("div");
    dlg.setAttribute("aria-modal", "true");
    document.body.append(dlg);
    press("ArrowRight", {}, document.body);
    dlg.remove();
    expect(run).not.toHaveBeenCalled();
  });

  it("respeita quem já tratou a tecla (defaultPrevented)", () => {
    const run = vi.fn();
    registerCommand("edit.delete", run);
    render(<Host />);
    const e = new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true });
    e.preventDefault();
    window.dispatchEvent(e);
    expect(run).not.toHaveBeenCalled();
  });

  it("um só sistema de atalhos: desmontar desliga", () => {
    const run = vi.fn();
    registerCommand("go.next", run);
    const { unmount } = render(<Host />);
    press("ArrowRight");
    unmount();
    press("ArrowRight");
    expect(run).toHaveBeenCalledTimes(1);
  });
});
