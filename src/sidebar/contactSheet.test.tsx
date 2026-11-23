// Folha de contatos (L7): seleção múltipla, teclado em grade, retângulo de seleção, arraste e ARIA.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo } from "../ipc/types";

const ipc = vi.hoisted(() => ({
  startDrag: vi.fn<(...a: unknown[]) => Promise<void>>(async () => {}),
  closeDocument: vi.fn<(...a: unknown[]) => Promise<void>>(async () => {}),
  copyFiles: vi.fn<(...a: unknown[]) => Promise<void>>(async () => {}),
  clipboardFiles: vi.fn<() => Promise<string[]>>(async () => []),
  openDocuments: vi.fn<(paths: string[]) => Promise<DocInfo[]>>(),
  thumbnail: vi.fn(),
}));
vi.mock("../ipc/commands", () => ipc);
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("./Thumb", () => ({ Thumb: () => null }));

import i18n from "../i18n";
import { resetToastsForTests } from "../chrome/notify";
import { answerUnsaved, currentUnsaved, resetUnsavedForTests } from "../file/unsaved";
import { resetDocsForTests, useDocs } from "../store/docs";
import { getPrefs, resetPrefsForTests, setPrefs } from "../store/prefs";
import { resetUiForTests, useUi } from "../store/ui";
import { ContactSheet } from "./ContactSheet";
import { useThumbSelection } from "./selection";

const doc = (id: number, over: Partial<DocInfo> = {}): DocInfo => ({
  id, path: `/p/${id}.png`, name: `${id}.png`, format: "png", width: 10, height: 10, frames: 1,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 0, error: null, ...over,
});

const COLS = 3;
/** Grade de 3 colunas de 100×100, com 10 px de intervalo, a partir de (10, 10). */
beforeAll(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const i = this.getAttribute("data-doc-index");
    if (i === null) return new DOMRect(0, 0, 800, 600);
    return new DOMRect(10 + (Number(i) % COLS) * 110, 10 + Math.floor(Number(i) / COLS) * 110, 100, 100);
  });
});

beforeEach(async () => {
  vi.clearAllMocks();
  resetDocsForTests();
  resetPrefsForTests();
  resetUiForTests();
  resetUnsavedForTests();
  resetToastsForTests();
  await i18n.changeLanguage("pt-BR");
  useUi.setState({ sidebar: "contact" });
  useThumbSelection.setState({ picked: [], anchor: null });
  useDocs.setState({ docs: [1, 2, 3, 4, 5, 6, 7].map((i) => doc(i)), activeId: 1 });
  ipc.openDocuments.mockImplementation(async (paths) => paths.map((p, i) => doc(50 + i, { path: p, name: p.slice(p.lastIndexOf("/") + 1) })));
});
afterEach(cleanup);

const opt = (n: number) => screen.getByRole("option", { name: `${n}.png` });
const grid = () => screen.getByRole("listbox");
const chosen = () => screen.getAllByRole("option").filter((o) => o.getAttribute("aria-selected") === "true").map((o) => Number(o.dataset.docId));
const active = () => useDocs.getState().activeId;
const order = () => useDocs.getState().docs.map((d) => d.id);
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const focused = () => Number((document.activeElement as HTMLElement | null)?.dataset.docId);

describe("ARIA e foco", () => {
  it("é um listbox de seleção múltipla com um só ponto de tabulação", () => {
    render(<ContactSheet />);
    expect(grid().getAttribute("aria-multiselectable")).toBe("true");
    expect(chosen()).toEqual([1]);
    const stops = () => screen.getAllByRole("option").filter((o) => o.tabIndex === 0).map((o) => Number(o.dataset.docId));
    expect(stops()).toEqual([1]);
    fireEvent.keyDown(opt(1), { key: "ArrowRight" });
    expect(stops()).toEqual([2]);
  });

  it("ao abrir, o foco vai para a imagem ativa (as setas já andam na grade)", () => {
    useDocs.setState({ activeId: 4 });
    render(<ContactSheet />);
    expect(focused()).toBe(4);
  });
});

describe("teclado", () => {
  it("setas andam na grade, Home e End vão às pontas e o foco acompanha", () => {
    render(<ContactSheet />);
    const press = (key: string, o = {}) => fireEvent.keyDown(opt(focused()), { key, ...o });
    press("ArrowDown");
    expect([active(), focused()]).toEqual([4, 4]);
    press("ArrowRight");
    expect(active()).toBe(5);
    press("ArrowUp");
    expect(active()).toBe(2);
    press("End");
    expect([active(), focused()]).toEqual([7, 7]);
    press("Home");
    expect(active()).toBe(1);
    expect(chosen()).toEqual([1]);
  });

  it("Shift+setas estendem; Ctrl+A seleciona todas", () => {
    render(<ContactSheet />);
    fireEvent.keyDown(opt(1), { key: "ArrowDown", shiftKey: true });
    expect(chosen()).toEqual([1, 2, 3, 4]);
    fireEvent.keyDown(opt(4), { key: "ArrowRight", shiftKey: true });
    expect(chosen()).toEqual([1, 2, 3, 4, 5]);
    fireEvent.keyDown(opt(5), { key: "a", ctrlKey: true });
    expect(chosen()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("Ctrl+seta leva só o foco; Espaço soma ou tira o item focado", () => {
    render(<ContactSheet />);
    fireEvent.keyDown(opt(1), { key: "ArrowRight", ctrlKey: true });
    fireEvent.keyDown(opt(2), { key: "ArrowRight", ctrlKey: true });
    expect([focused(), active()]).toEqual([3, 1]);
    expect(chosen()).toEqual([1]);
    fireEvent.keyDown(opt(3), { key: " " });
    expect(chosen()).toEqual([1, 3]);
    fireEvent.keyDown(opt(3), { key: " " });
    expect(chosen()).toEqual([1]);
  });

  it("Enter abre a imagem no visor", () => {
    render(<ContactSheet />);
    fireEvent.keyDown(opt(1), { key: "ArrowRight" });
    fireEvent.keyDown(opt(2), { key: "Enter" });
    expect(active()).toBe(2);
    expect(useUi.getState().sidebar).toBe("thumbs");
  });

  it("Delete fecha as selecionadas, perguntando pelas não salvas", async () => {
    useDocs.setState((s) => ({ docs: s.docs.map((d) => (d.id === 2 ? { ...d, dirty: true } : d)) }));
    render(<ContactSheet />);
    fireEvent.click(opt(2));
    fireEvent.click(opt(3), { ctrlKey: true });
    fireEvent.keyDown(opt(3), { key: "Delete" });
    expect(currentUnsaved()?.docs.map((d) => d.id)).toEqual([2]);
    act(() => answerUnsaved("cancel"));
    await flush();
    expect(order()).toEqual([1, 2, 3, 4, 5, 6, 7]);

    fireEvent.keyDown(opt(3), { key: "Backspace" });
    act(() => answerUnsaved("discard"));
    await flush();
    expect(order()).toEqual([1, 4, 5, 6, 7]);
    expect(ipc.closeDocument.mock.calls.map(([id]) => id)).toEqual([2, 3]);
  });
});

describe("mouse", () => {
  it("Ctrl e Shift somam e estendem; duplo clique abre", () => {
    render(<ContactSheet />);
    fireEvent.click(opt(2));
    fireEvent.click(opt(5), { ctrlKey: true });
    expect(chosen()).toEqual([2, 5]);
    fireEvent.click(opt(7), { shiftKey: true });
    expect(chosen()).toEqual([5, 6, 7]);
    fireEvent.doubleClick(opt(6));
    expect(useUi.getState().sidebar).toBe("thumbs");
    expect(active()).toBe(6);
  });

  it("retângulo de seleção no espaço vazio; com Ctrl soma ao que havia", () => {
    render(<ContactSheet />);
    fireEvent.pointerDown(grid(), { button: 0, clientX: 115, clientY: 5 });
    fireEvent.pointerMove(window, { clientX: 300, clientY: 150 });
    expect(chosen()).toEqual([2, 3, 5, 6]);
    expect(screen.getByTestId("marquee")).toBeTruthy();
    fireEvent.pointerUp(window, { clientX: 300, clientY: 150 });
    expect(screen.queryByTestId("marquee")).toBeNull();
    expect(chosen()).toEqual([2, 3, 5, 6]);

    fireEvent.pointerDown(grid(), { button: 0, clientX: 5, clientY: 225, ctrlKey: true });
    fireEvent.pointerMove(window, { clientX: 60, clientY: 300, ctrlKey: true });
    fireEvent.pointerUp(window, { clientX: 60, clientY: 300, ctrlKey: true });
    expect(chosen()).toEqual([2, 3, 5, 6, 7]);
  });

  it("clicar no vazio desfaz a seleção múltipla", () => {
    render(<ContactSheet />);
    fireEvent.click(opt(2));
    fireEvent.click(opt(3), { ctrlKey: true });
    fireEvent.pointerDown(grid(), { button: 0, clientX: 700, clientY: 500 });
    fireEvent.pointerUp(window, { clientX: 700, clientY: 500 });
    expect(chosen()).toEqual([3]);
  });

  it("menu de contexto age na seleção; Abrir mostra a imagem no visor", () => {
    render(<ContactSheet />);
    fireEvent.contextMenu(opt(4), { clientX: 5, clientY: 5 });
    expect(chosen()).toEqual([4]);
    fireEvent.click(within(screen.getByRole("menu")).getByText("Abrir"));
    expect(active()).toBe(4);
    expect(useUi.getState().sidebar).toBe("thumbs");
  });

  it("fechar o menu devolve o foco à miniatura", async () => {
    render(<ContactSheet />);
    fireEvent.contextMenu(opt(4), { clientX: 5, clientY: 5 });
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await flush();
    expect(focused()).toBe(4);
  });
});

describe("arraste", () => {
  const drag = (from: number, x: number, y: number) => {
    fireEvent.pointerDown(opt(from), { button: 0, clientX: 60, clientY: 60 });
    fireEvent.pointerMove(window, { clientX: x, clientY: y });
  };

  it("reordena em grade e passa a ordem para manual", () => {
    setPrefs({ sortBy: "name" });
    render(<ContactSheet />);
    drag(1, 200, 160); // metade direita do item 5
    expect(opt(6).className).toContain("drop-before");
    fireEvent.pointerUp(window, { clientX: 200, clientY: 160 });
    expect(order()).toEqual([2, 3, 4, 5, 1, 6, 7]);
    expect(getPrefs().sortBy).toBe("manual");
  });

  it("arrastar uma das selecionadas leva todas", () => {
    render(<ContactSheet />);
    fireEvent.click(opt(1));
    fireEvent.click(opt(3), { ctrlKey: true });
    drag(3, 700, 700);
    fireEvent.pointerUp(window, { clientX: 700, clientY: 700 });
    expect(order()).toEqual([2, 4, 5, 6, 7, 1, 3]);
  });

  it("sair da janela começa o arraste nativo com a seleção", () => {
    render(<ContactSheet />);
    fireEvent.click(opt(1));
    fireEvent.click(opt(3), { ctrlKey: true });
    drag(3, -5, 60);
    expect(ipc.startDrag).toHaveBeenCalledWith([{ id: 1, export: false }, { id: 3, export: false }]);
  });

  it("o clique que encerra um arraste não muda a seleção", () => {
    render(<ContactSheet />);
    drag(2, 200, 160);
    fireEvent.pointerUp(window, { clientX: 200, clientY: 160 });
    fireEvent.click(opt(2));
    expect(active()).toBe(1);
  });
});

describe("copiar e colar arquivos", () => {
  it("Ctrl+C copia as selecionadas como arquivos (a alterada, como PNG)", async () => {
    useDocs.setState((s) => ({ docs: s.docs.map((d) => (d.id === 3 ? { ...d, dirty: true } : d)) }));
    render(<ContactSheet />);
    fireEvent.click(opt(1));
    fireEvent.click(opt(3), { ctrlKey: true });
    fireEvent.keyDown(opt(3), { key: "c", ctrlKey: true });
    await flush();
    expect(ipc.copyFiles).toHaveBeenCalledWith([{ id: 1, export: false }, { id: 3, export: true }], 0);
  });

  it("Ctrl+V abre os arquivos copiados depois da seleção, na ordem", async () => {
    ipc.clipboardFiles.mockResolvedValue(["/x/São João.png", "/x/b.png"]);
    render(<ContactSheet />);
    fireEvent.click(opt(2));
    fireEvent.keyDown(opt(2), { key: "v", ctrlKey: true });
    await flush();
    expect(ipc.openDocuments).toHaveBeenCalledWith(["/x/São João.png", "/x/b.png"]);
    expect(order()).toEqual([1, 2, 50, 51, 3, 4, 5, 6, 7]);
    expect(active()).toBe(50);
    expect(chosen()).toEqual([50, 51]);
  });
});
