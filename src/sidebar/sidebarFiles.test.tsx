// Barra lateral como lista de arquivos (L18/L19): fechar, Lixo, copiar, colar e soltar numa posição.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo } from "../ipc/types";

const ipc = vi.hoisted(() => ({
  closeDocument: vi.fn<(...a: unknown[]) => Promise<void>>(async () => {}),
  moveToTrash: vi.fn<(id: number) => Promise<void>>(async () => {}),
  copyFiles: vi.fn<(...a: unknown[]) => Promise<void>>(async () => {}),
  copyRegion: vi.fn<(...a: unknown[]) => Promise<void>>(async () => {}),
  clipboardFiles: vi.fn<() => Promise<string[]>>(async () => []),
  clipboardImage: vi.fn(async () => new Uint8Array()),
  openDocuments: vi.fn<(paths: string[]) => Promise<DocInfo[]>>(),
  duplicate: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  applyOp: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  setVersionsLimit: vi.fn(async () => {}),
}));
vi.mock("../ipc/commands", () => ipc);
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
const webview = vi.hoisted(() => ({ drag: (() => {}) as (payload: unknown) => void }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async (cb: (e: { payload: unknown }) => void) => {
      webview.drag = (payload) => cb({ payload });
      return () => {};
    },
  }),
}));
vi.mock("./Thumb", () => ({ Thumb: () => null }));
vi.mock("../markup/render", async (orig) => ({
  ...(await orig<typeof import("../markup/render")>()),
  flattenToPng: vi.fn(async () => new Uint8Array([1])),
}));

import i18n from "../i18n";
import { getToasts, resetToastsForTests } from "../chrome/notify";
import "../finder/register";
import { resetFinderUiForTests, useFinderUi, answerConfirm } from "../finder/store";
import { resetUnsavedForTests } from "../file/unsaved";
import type { Annotation } from "../markup/model";
import { useMarkup } from "../markup/store";
import { registerAppCommands } from "../shortcuts/appCommands";
import { runCommand } from "../shortcuts/commands";
import { matchShortcut } from "../shortcuts/keymap";
import { useShortcuts } from "../shortcuts/useShortcuts";
import { resetDocsForTests, useDocs } from "../store/docs";
import { getPrefs, resetPrefsForTests, setPrefs } from "../store/prefs";
import { useSelection } from "../store/selection";
import { resetUiForTests, useUi } from "../store/ui";
import { useFileDrop } from "../viewer/fileDrop";
import { useBatch } from "./batch";
import { useThumbSelection } from "./selection";
import { Sidebar } from "./Sidebar";
import { trashDocs } from "./trash";
import { FinderHost } from "../finder/FinderHost";

const doc = (id: number, over: Partial<DocInfo> = {}): DocInfo => ({
  id, path: `/p/${id}.png`, name: `${id}.png`, format: "png", width: 10, height: 10, frames: 1,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 0, error: null, ...over,
});

/** Lista de itens de 100 px de altura, na barra de 168 px de largura. */
beforeAll(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const i = this.getAttribute("data-doc-index");
    return i === null ? new DOMRect(0, 0, 168, 600) : new DOMRect(8, Number(i) * 100, 150, 100);
  });
});

let off: () => void;
beforeEach(async () => {
  vi.clearAllMocks();
  ipc.moveToTrash.mockImplementation(async () => {});
  resetDocsForTests();
  resetPrefsForTests();
  resetUiForTests();
  resetUnsavedForTests();
  resetFinderUiForTests();
  resetToastsForTests();
  useBatch.setState({ running: false, done: 0, total: 0 });
  useSelection.setState({ selection: null, selectionTool: null });
  useMarkup.setState({ docs: {}, selected: {} });
  await i18n.changeLanguage("pt-BR");
  useUi.setState({ sidebar: "thumbs" });
  useThumbSelection.setState({ picked: [], anchor: null });
  useDocs.setState({ docs: [1, 2, 3, 4].map((i) => doc(i)), activeId: 1 });
  ipc.openDocuments.mockImplementation(async (paths) => paths.map((p, i) => doc(50 + i, { path: p, name: p.slice(p.lastIndexOf("/") + 1) })));
  off = registerAppCommands();
});
afterEach(() => {
  off();
  cleanup();
});

const item = (n: number) => screen.getByText(`${n}.png`).closest("button") as HTMLButtonElement;
const order = () => useDocs.getState().docs.map((d) => d.id);
/** Espera as continuações e o fim de um lote em andamento (que cede a vez entre as imagens). */
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 5));
    await vi.waitFor(() => expect(useBatch.getState().running).toBe(false));
  });
const select = (...ids: number[]) => ids.forEach((n, i) => fireEvent.click(item(n), { ctrlKey: i > 0 }));
const toasts = () => getToasts().map((t) => t.text);

describe("Delete na barra lateral", () => {
  it("fecha as selecionadas e deixa o arquivo no disco", async () => {
    render(<Sidebar />);
    select(2, 4);
    fireEvent.keyDown(item(4), { key: "Delete" });
    await flush();
    expect(order()).toEqual([1, 3]);
    expect(ipc.moveToTrash).not.toHaveBeenCalled();
  });

  it("depois de clicar no visor, o Delete é da imagem", () => {
    render(
      <>
        <Sidebar />
        <div className="viewport" data-testid="vp" />
      </>,
    );
    select(2);
    expect(document.activeElement).toBe(item(2));
    fireEvent.pointerDown(screen.getByTestId("vp"));
    expect(document.activeElement).toBe(document.body);
  });
});

describe("Mover para o Lixo com várias selecionadas", () => {
  it("Ctrl+Backspace e Ctrl+Delete são o mesmo comando", () => {
    const key = (k: string) => matchShortcut(new KeyboardEvent("keydown", { key: k, ctrlKey: true }));
    expect(key("Backspace")).toBe("file.moveToTrash");
    expect(key("Delete")).toBe("file.moveToTrash");
  });

  it("pelo atalho, com 2 ou mais, pergunta antes (o padrão é Cancelar)", async () => {
    render(
      <>
        <Sidebar />
        <FinderHost />
      </>,
    );
    select(2, 3);
    act(() => void runCommand("file.moveToTrash"));
    expect(useFinderUi.getState().confirm).toMatchObject({ text: "finder.trash.confirmMany", ok: "finder.trash.ok" });
    expect(screen.getByRole("alertdialog", { name: "Mover 2 itens para o Lixo?" })).toBeTruthy();
    expect(document.activeElement?.textContent).toBe("Cancelar");
    act(() => answerConfirm(false));
    await flush();
    expect(ipc.moveToTrash).not.toHaveBeenCalled();
    expect(order()).toEqual([1, 2, 3, 4]);
  });

  it("move todas, fecha e dá um aviso só", async () => {
    render(<Sidebar />);
    select(2, 3);
    runCommand("file.moveToTrash");
    act(() => answerConfirm(true));
    await flush();
    expect(ipc.moveToTrash.mock.calls).toEqual([[2], [3]]);
    expect(order()).toEqual([1, 4]);
    expect(toasts()).toEqual(["2 imagens foram para o Lixo"]);
  });

  it("as não salvas são perguntadas uma vez; Cancelar não move nada", async () => {
    useDocs.setState((s) => ({ docs: s.docs.map((d) => (d.id < 3 ? { ...d, dirty: true } : d)) }));
    render(<Sidebar />);
    select(1, 2);
    fireEvent.click(item(3), { ctrlKey: true });
    runCommand("file.moveToTrash");
    expect(useFinderUi.getState().confirm).toMatchObject({ name: "1.png, 2.png", text: "finder.trash.confirmUnsavedMany" });
    act(() => answerConfirm(false));
    await flush();
    expect(ipc.moveToTrash).not.toHaveBeenCalled();
    runCommand("file.moveToTrash");
    act(() => answerConfirm(true));
    await flush();
    expect(order()).toEqual([4]);
  });

  it("uma falha deixa aquela aberta e não impede as outras", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    ipc.moveToTrash.mockImplementation(async (id) => {
      if (id === 2) throw { code: "permission", message: "x" };
    });
    render(<Sidebar />);
    select(1, 2, 3);
    runCommand("file.moveToTrash");
    act(() => answerConfirm(true));
    await flush();
    expect(order()).toEqual([2, 4]);
    expect(toasts()).toEqual(["2 de 3 imagens processadas. Falhou: 2.png."]);
  });

  it("já no Lixo mas sem poder fechar: não conta como falha de mover, e avisa", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    ipc.closeDocument.mockImplementation(async (id) => {
      if (id === 2) throw { code: "io", message: "x" };
    });
    render(<Sidebar />);
    select(2, 3);
    runCommand("file.moveToTrash");
    act(() => answerConfirm(true));
    await flush();
    expect(ipc.moveToTrash.mock.calls).toEqual([[2], [3]]);
    expect(toasts()).toEqual(["2.png foi para o Lixo, mas não pôde ser fechado", "2 imagens foram para o Lixo"]);
  });

  it("uma imagem só que falha: avisa o erro, sem rejeição solta", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    ipc.moveToTrash.mockRejectedValue({ code: "permission", message: "x" });
    render(<Sidebar />);
    select(2);
    await act(async () => void (await trashDocs([2])));
    expect(order()).toEqual([1, 2, 3, 4]);
    expect(toasts()).toHaveLength(1);
  });

  it("com as miniaturas escondidas, só a imagem ativa (a seleção não está à vista)", async () => {
    render(<Sidebar />);
    select(2, 3);
    useUi.setState({ sidebar: "hidden" });
    runCommand("file.moveToTrash");
    await flush();
    expect(ipc.moveToTrash.mock.calls).toEqual([[3]]);
  });

  it("pelo menu da miniatura, com as que têm arquivo em disco", async () => {
    useDocs.setState((s) => ({ docs: s.docs.map((d) => (d.id === 3 ? { ...d, path: "" } : d)) }));
    render(<Sidebar />);
    select(2, 3, 4);
    fireEvent.contextMenu(item(4), { clientX: 5, clientY: 5 });
    fireEvent.click(within(screen.getByRole("menu")).getByText("Mover 2 Imagens para o Lixo"));
    await flush();
    expect(ipc.moveToTrash.mock.calls).toEqual([[2], [4]]);
  });
});

describe("copiar e colar", () => {
  it("Editar › Copiar com várias selecionadas copia os arquivos; com seleção na imagem, os pixels", async () => {
    render(<Sidebar />);
    select(1, 2);
    runCommand("edit.copy");
    await flush();
    expect(ipc.copyFiles).toHaveBeenCalledWith([{ id: 1, export: false }, { id: 2, export: false }], 0);
    useSelection.setState({ selection: { type: "rect", data: { x: 0, y: 0, w: 2, h: 2 } } });
    runCommand("edit.copy");
    await flush();
    expect(ipc.copyFiles).toHaveBeenCalledOnce();
    expect(ipc.copyRegion).toHaveBeenCalledOnce();
  });

  it("Ctrl+C na barra lateral com seleção na imagem: os pixels, como Editar › Copiar", async () => {
    function Keys() {
      useShortcuts();
      return null;
    }
    render(
      <>
        <Sidebar />
        <Keys />
      </>,
    );
    select(1, 2);
    useSelection.setState({ selection: { type: "rect", data: { x: 0, y: 0, w: 2, h: 2 } } });
    fireEvent.keyDown(item(2), { key: "c", code: "KeyC", ctrlKey: true });
    await flush();
    expect(ipc.copyFiles).not.toHaveBeenCalled();
    expect(ipc.copyRegion).toHaveBeenCalledOnce();
  });

  it("anotações não achatadas entram na cópia, e a cópia temporária é fechada", async () => {
    useMarkup.setState({ docs: { 2: [{ id: "a", kind: "rect" } as unknown as Annotation] }, selected: {} });
    ipc.duplicate.mockResolvedValue(doc(90, { path: "" }));
    ipc.applyOp.mockResolvedValue(doc(90, { path: "", rev: 1 }));
    render(<Sidebar />);
    select(2);
    fireEvent.keyDown(item(2), { key: "c", ctrlKey: true });
    await flush();
    expect(ipc.copyFiles).toHaveBeenCalledWith([{ id: 90, export: true }], 0);
    expect(ipc.closeDocument).toHaveBeenCalledWith(90);
    expect(order()).toEqual([1, 2, 3, 4]);
  });

  it("colar arquivos abre depois da seleção; sem arquivos, segue o Colar de sempre", async () => {
    ipc.clipboardFiles.mockResolvedValueOnce(["/x/São João.png"]);
    render(<Sidebar />);
    select(3);
    fireEvent.keyDown(item(3), { key: "v", ctrlKey: true });
    await flush();
    expect(order()).toEqual([1, 2, 3, 50, 4]);
    fireEvent.keyDown(item(3), { key: "v", ctrlKey: true });
    await flush();
    expect(order()).toEqual([1, 2, 3, 50, 4]);
  });
});

describe("soltar arquivos numa posição", () => {
  function Host() {
    const over = useFileDrop();
    return (
      <>
        <Sidebar />
        {over && <p>soltar na janela</p>}
      </>
    );
  }

  it("mostra o lugar, abre ali na ordem e passa a ordem para manual", async () => {
    setPrefs({ sortBy: "name" });
    const { container } = render(<Host />);
    act(() => webview.drag({ type: "enter", paths: ["/x/b.png", "/x/ação.png"], position: { x: 400, y: 10 } }));
    expect(screen.getByText("soltar na janela")).toBeTruthy();
    act(() => webview.drag({ type: "over", position: { x: 50, y: 120 } }));
    expect(screen.queryByText("soltar na janela")).toBeNull();
    expect(container.querySelector(".drop-line")?.parentElement?.contains(item(2))).toBe(true);
    act(() => webview.drag({ type: "drop", paths: ["/x/b.png", "/x/ação.png"], position: { x: 50, y: 120 } }));
    await flush();
    expect(order()).toEqual([1, 50, 51, 2, 3, 4]);
    expect(useDocs.getState().activeId).toBe(50);
    expect(getPrefs().sortBy).toBe("manual");
    expect(container.querySelector(".drop-line")).toBeNull();
  });

  it("fora da barra lateral continua abrindo no fim", async () => {
    render(<Host />);
    act(() => webview.drag({ type: "drop", paths: ["/x/b.png"], position: { x: 400, y: 120 } }));
    await flush();
    expect(order()).toEqual([1, 2, 3, 4, 50]);
  });

  it("sair da janela limpa a marca", () => {
    const { container } = render(<Host />);
    act(() => webview.drag({ type: "enter", paths: ["/x/b.png"], position: { x: 50, y: 120 } }));
    expect(container.querySelector(".drop-line")).toBeTruthy();
    act(() => webview.drag({ type: "leave" }));
    expect(container.querySelector(".drop-line")).toBeNull();
  });
});
