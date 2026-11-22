import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo } from "../ipc/types";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../ipc/commands", async (orig) => ({ ...(await orig<typeof import("../ipc/commands")>()), startDrag: vi.fn() }));

import i18n from "../i18n";
import { resetToastsForTests } from "../chrome/notify";
import { closePrint, usePrintUi } from "../print/print";
import { resetDocsForTests, useDocs } from "../store/docs";
import { getPrefs, resetPrefsForTests, setPrefs } from "../store/prefs";
import { useBatch } from "./batch";
import { useThumbSelection } from "./selection";
import { Sidebar } from "./Sidebar";

const doc = (id: number, over: Partial<DocInfo> = {}): DocInfo => ({
  id, path: `/p/${id}.png`, name: `${id}.png`, format: "png", width: 10, height: 10, frames: 1,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 0, error: null, ...over,
});

beforeAll(() => {
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });
});

beforeEach(async () => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, a: { id?: number }) => (cmd === "apply_op" ? { ...doc(a.id!), rev: 1, canUndo: true } : undefined));
  resetDocsForTests();
  resetPrefsForTests();
  await i18n.changeLanguage("pt-BR");
  resetToastsForTests();
  useThumbSelection.setState({ picked: [], anchor: null });
  useBatch.setState({ running: false, done: 0, total: 0 });
  useDocs.setState({ docs: [1, 2, 3, 4].map((i) => doc(i)), activeId: 1 });
});
afterEach(cleanup);

const item = (n: number) => screen.getByText(`${n}.png`).closest("button") as HTMLButtonElement;
const active = () => useDocs.getState().activeId;
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

describe("multisseleção", () => {
  it("Ctrl-clique alterna e Shift-clique estende a partir da âncora", () => {
    render(<Sidebar />);
    fireEvent.click(item(2));
    fireEvent.click(item(4), { ctrlKey: true });
    expect(item(2).getAttribute("aria-pressed")).toBe("true");
    expect(item(4).getAttribute("aria-pressed")).toBe("true");
    expect(item(3).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(item(1));
    fireEvent.click(item(3), { shiftKey: true });
    expect([1, 2, 3].every((n) => item(n).getAttribute("aria-pressed") === "true")).toBe(true);
    expect(item(4).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("3 selecionadas")).toBeTruthy();
  });

  it("setas movem a seleção; Shift+seta estende; Ctrl+A seleciona todas", () => {
    render(<Sidebar />);
    fireEvent.keyDown(item(1), { key: "ArrowDown" });
    expect(active()).toBe(2);
    fireEvent.keyDown(item(2), { key: "ArrowDown", shiftKey: true });
    expect(active()).toBe(3);
    expect(useThumbSelection.getState().picked).toEqual([2, 3]);
    fireEvent.keyDown(item(3), { key: "a", ctrlKey: true });
    expect(useThumbSelection.getState().picked).toEqual([1, 2, 3, 4]);
  });
});

describe("menu de contexto da miniatura", () => {
  const open = (n: number) => fireEvent.contextMenu(item(n), { clientX: 5, clientY: 5 });

  it("botão direito fora da seleção seleciona só aquela miniatura", () => {
    render(<Sidebar />);
    fireEvent.click(item(1));
    fireEvent.click(item(2), { ctrlKey: true });
    open(4);
    expect(active()).toBe(4);
    expect(useThumbSelection.getState().picked).toEqual([4]);
    expect(screen.getByRole("menu")).toBeTruthy();
    // Uma só imagem: Abrir habilitado.
    expect(screen.getByText("Abrir").closest("li")!.getAttribute("aria-disabled")).toBe("false");
  });

  it("Girar à Direita com várias selecionadas aplica a Op em cada uma, cada qual com o próprio desfazer", async () => {
    render(<Sidebar />);
    fireEvent.click(item(1));
    fireEvent.click(item(3), { ctrlKey: true });
    open(3);
    const menu = within(screen.getByRole("menu"));
    expect(menu.getByText("Abrir").closest("li")!.getAttribute("aria-disabled")).toBe("true");
    expect(menu.getByText("Mostrar na Pasta").closest("li")!.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(menu.getByText("Girar à Direita"));
    await flush();
    const calls = invoke.mock.calls.filter(([c]) => c === "apply_op").map(([, a]) => [(a as { id: number }).id, (a as { op: unknown }).op]);
    expect(calls).toEqual([
      [1, { type: "rotate", data: { quarterTurns: 1 } }],
      [3, { type: "rotate", data: { quarterTurns: 1 } }],
    ]);
    expect(useDocs.getState().docs.map((d) => d.canUndo)).toEqual([true, false, true, false]);
  });

  it("Imprimir com várias selecionadas abre um diálogo só, com todas, sem trocar a imagem ativa", () => {
    render(<Sidebar />);
    fireEvent.click(item(1));
    fireEvent.click(item(3), { ctrlKey: true });
    open(3);
    const antes = active();
    fireEvent.click(within(screen.getByRole("menu")).getByText("Imprimir 2 Imagens…"));
    expect(usePrintUi.getState().ids).toEqual([1, 3]);
    expect(active()).toBe(antes);
    closePrint();
  });

  it("uma falha no meio do lote não impede as demais e vira um aviso com o nome", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    invoke.mockImplementation(async (cmd: string, a: { id?: number }) => {
      if (cmd !== "apply_op") return undefined;
      if (a.id === 2) throw { code: "io", message: "sem espaço" };
      return { ...doc(a.id!), rev: 1, canUndo: true };
    });
    render(<Sidebar />);
    fireEvent.click(item(1));
    fireEvent.click(item(3), { shiftKey: true });
    open(2);
    fireEvent.click(within(screen.getByRole("menu")).getByText("Espelhar Horizontalmente"));
    await flush();
    expect(invoke.mock.calls.filter(([c]) => c === "apply_op")).toHaveLength(3);
    const { getToasts } = await import("../chrome/notify");
    expect(getToasts().map((t) => t.text)).toEqual(["2 de 3 imagens processadas. Falhou: 2.png."]);
  });
});

describe("arraste e ordenação", () => {
  it("arrastar uma miniatura volta a ordem para manual", () => {
    setPrefs({ sortBy: "name" });
    render(<Sidebar />);
    fireEvent.pointerDown(item(1), { button: 0, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 50, clientY: 100 });
    fireEvent.pointerUp(window, { clientX: 50, clientY: 100 });
    expect(getPrefs().sortBy).toBe("manual");
  });
});
