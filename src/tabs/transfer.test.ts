import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo, Incoming } from "../ipc/types";

const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {};
const calls: [string, Record<string, unknown> | undefined][] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    calls.push([cmd, args]);
    return handlers[cmd]?.(args ?? {});
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onCloseRequested: async () => () => {} }) }));
const dialog = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => dialog);
const toast = vi.hoisted(() => vi.fn());
vi.mock("../chrome/notify", () => ({ notify: toast, notifyError: toast }));

import "../markup/register";
import "../select/register";
import { registerDirtySource, hasUnsaved } from "../file/dirty";
import { markChanged, useFileUi } from "../file/fileActions";
import { registerFileCommands } from "../file/register";
import { addKeyword, getPendingKeywords, resetKeywordsForTests } from "../inspector/keywords";
import { track } from "../ipc/inflight";
import { canUndo, pushMarkup, pushOp, undo } from "../markup/history";
import { DEFAULT_STYLE, type Annotation } from "../markup/model";
import { getItems, getSelected, useMarkup } from "../markup/store";
import { useBatch } from "../sidebar/batch";
import { useThumbSelection } from "../sidebar/selection";
import { resetDocsForTests, useDocs } from "../store/docs";
import { resetPrefsForTests, getPrefs } from "../store/prefs";
import { useSelection } from "../store/selection";
import { resetUiForTests, useUi } from "../store/ui";
import { open as openNative } from "../lib/dialogs";
import { putVeil, resetTabsForTests, useTabs } from "./store";
import { sendAllTo } from "./closing";
import { mergeAllWindows, movable, moveTabToNewWindow, receiveDocs } from "./transfer";

registerFileCommands();

const info = (id: number, extra: Partial<DocInfo> = {}): DocInfo => ({
  id, path: `/p/${id}.png`, name: `${id}.png`, format: "png", width: 40, height: 30, frames: 1,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 0, error: null, ...extra,
});
const rect = (id: string): Annotation => ({ id, kind: "rect", geom: { x: 1, y: 1, w: 5, h: 5 }, style: { ...DEFAULT_STYLE } });
const ids = () => useDocs.getState().docs.map((d) => d.id);
const sent = (cmd: string) => calls.filter(([c]) => c === cmd).map(([, a]) => a!);
const open = (...list: DocInfo[]) => {
  useDocs.getState().add(list);
  useDocs.getState().setActive(list[0].id);
};
/** O que a janela de destino faria com a entrega. */
const deliver = (list: Incoming[]) => (handlers.take_documents = () => list.splice(0));

beforeEach(() => {
  for (const k of Object.keys(handlers)) delete handlers[k];
  calls.length = 0;
  toast.mockReset();
  resetDocsForTests();
  resetTabsForTests();
  resetUiForTests();
  resetPrefsForTests();
  resetKeywordsForTests();
  useThumbSelection.setState({ picked: [], anchor: null });
  useBatch.setState({ running: false });
  useFileUi.setState({ changed: {} });
  useMarkup.setState({ docs: {}, selected: {} });
  document.body.innerHTML = "";
});
afterEach(resetTabsForTests);

describe("Mover Aba para Nova Janela", () => {
  it("leva a aba ativa, ou as miniaturas escolhidas, e nunca todas", () => {
    open(info(1), info(2), info(3));
    expect(movable()).toEqual([1]);
    useThumbSelection.setState({ picked: [1, 3], anchor: 1 });
    expect(movable()).toEqual([1, 3]);
    useThumbSelection.setState({ picked: [1, 2, 3], anchor: 1 });
    expect(movable()).toEqual([]);
    resetDocsForTests();
    open(info(1));
    expect(movable()).toEqual([]);
  });

  it("documento com erro também muda de janela", () => {
    open(info(1, { error: "corrupt", width: 0, height: 0 }), info(2));
    expect(movable()).toEqual([1]);
  });

  it("tira da origem sem fechar no Rust e ativa a vizinha", async () => {
    open(info(1), info(2), info(3));
    useDocs.getState().setActive(2);
    await moveTabToNewWindow();
    expect(sent("new_window")[0].ids).toEqual([2]);
    expect(sent("close_document")).toEqual([]);
    expect(ids()).toEqual([1, 3]);
    expect(useDocs.getState().activeId).toBe(3);
    expect(useTabs.getState().veil).toBeNull();
  });

  it("se a janela não abre, nada muda na origem", async () => {
    open(info(1), info(2));
    useMarkup.getState().setItems(1, [rect("a")]);
    handlers.new_window = () => Promise.reject({ code: "io" });
    await moveTabToNewWindow();
    expect(ids()).toEqual([1, 2]);
    expect(getItems(1)).toHaveLength(1);
    expect(toast).toHaveBeenCalled();
    expect(useTabs.getState().veil).toBeNull();
  });

  it("anotações, desfazer, palavras-chave, faixa de disco, página e seleção chegam iguais", async () => {
    open(info(1, { canUndo: true, frames: 3 }), info(2));
    const [a, b] = [rect("a"), rect("b")].map((r) => ({ ...r, page: 2 }));
    useUi.getState().setPage(2);
    useMarkup.getState().setItems(1, [a, b]);
    useMarkup.getState().select(1, ["b"]);
    pushOp(1);
    pushMarkup(1, [], [a]);
    pushMarkup(1, [a], [a, b]);
    addKeyword(1, "praia");
    markChanged(1, false);
    const selection = { type: "rect", data: { x: 1, y: 2, w: 3, h: 4 } } as never;
    useSelection.getState().setSelection(selection);

    await moveTabToNewWindow();
    const { state } = sent("new_window")[0] as { state: string };
    // A origem esqueceu tudo.
    expect(getItems(1)).toEqual([]);
    expect(getPendingKeywords(1)).toBeNull();
    expect(useFileUi.getState().changed).toEqual({});
    expect(canUndo(1)).toBe(false);
    expect(useSelection.getState().selection).toBeNull();

    // E o destino recebe.
    resetDocsForTests();
    useUi.getState().setPage(null);
    deliver([{ infos: [info(1, { canUndo: true, frames: 3 })], state }]);
    await receiveDocs();
    expect(useDocs.getState().activeId).toBe(1);
    expect(getItems(1).map((x) => x.id)).toEqual(["a", "b"]);
    expect(getSelected(1)).toEqual(["b"]);
    expect(getPendingKeywords(1)).toEqual(["praia"]);
    expect(useFileUi.getState().changed).toEqual({ 1: false });
    expect(useUi.getState().page).toBe(2);
    expect(useSelection.getState().selection).toEqual(selection);
    expect(hasUnsaved(info(1))).toBe(true);
    await undo(1);
    expect(getItems(1).map((x) => x.id)).toEqual(["a"]);
    await undo(1);
    expect(getItems(1)).toEqual([]);
    handlers.undo = () => info(1, { rev: 1, canRedo: true });
    await undo(1);
    expect(sent("undo")).toEqual([{ id: 1 }]);
  });

  it("espera o comando em andamento no documento antes de levar", async () => {
    open(info(1), info(2));
    let finish!: () => void;
    void track("apply_op", { id: 1 }, new Promise<void>((r) => (finish = r)));
    const move = moveTabToNewWindow();
    await vi.waitFor(() => expect(useTabs.getState().veil).toBe("moving"));
    expect(sent("new_window")).toEqual([]);
    finish();
    await move;
    expect(sent("new_window")).toHaveLength(1);
  });

  it.each([
    ["diálogo aberto", () => (document.body.innerHTML = '<div aria-modal="true"></div>')],
    ["Ajustar Cor aberto", () => (document.body.innerHTML = '<div class="adjust-panel"></div>')],
    ["lote em andamento", () => useBatch.setState({ running: true })],
    ["apresentação", () => useUi.setState({ slideshow: true })],
  ])("recusa com %s", async (_n, arrange) => {
    open(info(1), info(2));
    arrange();
    await moveTabToNewWindow();
    expect(sent("new_window")).toEqual([]);
    expect(ids()).toEqual([1, 2]);
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it("recusa com um seletor de arquivos do sistema aberto", async () => {
    open(info(1), info(2));
    let close!: (v: null) => void;
    dialog.open.mockReturnValueOnce(new Promise((r) => (close = r)));
    const picking = openNative({ directory: true });
    await moveTabToNewWindow();
    expect(sent("new_window")).toEqual([]);
    expect(toast).toHaveBeenCalledTimes(1);
    close(null);
    await picking;
    await moveTabToNewWindow();
    expect(sent("new_window")).toHaveLength(1);
  });

  it("o fim do mover não tira o véu dos outros", async () => {
    open(info(1), info(2));
    handlers.new_window = () => void putVeil("closing");
    await moveTabToNewWindow();
    expect(useTabs.getState().veil).toBe("closing");
  });

  it("alteração que não há como levar recusa e avisa, sem perder nada", async () => {
    open(info(1), info(2));
    const off = registerDirtySource((id) => id === 1);
    await moveTabToNewWindow();
    expect(sent("new_window")).toEqual([]);
    expect(ids()).toEqual([1, 2]);
    expect(toast.mock.calls[0][0]).toContain("1.png");
    off();
  });

  it("confirma o texto em edição antes de levar", async () => {
    open(info(1), info(2));
    const input = document.body.appendChild(document.createElement("input"));
    input.addEventListener("blur", () => useMarkup.getState().setItems(1, [rect("texto")]));
    input.focus();
    await moveTabToNewWindow();
    expect(sent("new_window")[0].state).toContain("texto");
  });
});

describe("receber documentos", () => {
  it("estado ilegível não impede o documento de chegar", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    open(info(9));
    deliver([{ infos: [info(1)], state: "{{" }]);
    await receiveDocs();
    expect(ids()).toEqual([9, 1]);
    expect(useDocs.getState().activeId).toBe(1);
  });

  it("chamado de novo sem entregas não muda nada", async () => {
    open(info(9));
    deliver([]);
    await receiveDocs();
    expect(useDocs.getState().activeId).toBe(9);
  });
});

describe("Juntar Todas as Janelas", () => {
  it("pede às outras e mostra a barra de abas", async () => {
    await mergeAllWindows();
    expect(sent("merge_windows")).toHaveLength(1);
    expect(getPrefs().tabBar).toBe(true);
  });

  it("a outra janela manda tudo e se fecha", async () => {
    open(info(1), info(2));
    handlers.seal_window = () => true;
    await sendAllTo("doc-3");
    expect(sent("move_documents")[0]).toMatchObject({ ids: [1, 2], to: "doc-3" });
    expect(sent("close_window")).toHaveLength(1);
  });

  it("janela sem documentos só se fecha", async () => {
    handlers.seal_window = () => true;
    await sendAllTo("main");
    expect(sent("move_documents")).toEqual([]);
    expect(sent("close_window")).toHaveLength(1);
  });

  it("se não deu para mover, a janela continua aberta com tudo", async () => {
    open(info(1));
    handlers.move_documents = () => Promise.reject({ code: "unsupported" });
    await sendAllTo("doc-3");
    expect(ids()).toEqual([1]);
    expect(sent("seal_window")).toEqual([]);
    expect(sent("close_window")).toEqual([]);
    expect(sent("decline_merge")).toEqual([{ to: "doc-3" }]);
  });

  it("com um diálogo aberto, quem pediu fica sabendo", async () => {
    open(info(1));
    document.body.innerHTML = '<div aria-modal="true"></div>';
    await sendAllTo("doc-3");
    expect(sent("decline_merge")).toEqual([{ to: "doc-3" }]);
    expect(sent("move_documents")).toEqual([]);
  });

  it("vazia, mas com um diálogo aberto, também avisa quem pediu", async () => {
    document.body.innerHTML = '<div aria-modal="true"></div>';
    await sendAllTo("doc-3");
    expect(sent("decline_merge")).toEqual([{ to: "doc-3" }]);
    expect(sent("close_window")).toEqual([]);
  });

  it("duas janelas juntando ao mesmo tempo: a que recebeu documentos não fecha", async () => {
    open(info(1));
    handlers.seal_window = () => false;
    deliver([{ infos: [info(2)], state: "null" }]);
    await sendAllTo("doc-3");
    expect(sent("close_window")).toEqual([]);
    expect(ids()).toEqual([2]);
    expect(useTabs.getState().veil).toBeNull();
  });

  it("documento aberto durante a mudança fica na janela, que não fecha", async () => {
    open(info(1));
    handlers.move_documents = () => void useDocs.getState().add([info(7)]);
    await sendAllTo("doc-3");
    expect(ids()).toEqual([7]);
    expect(sent("seal_window")).toEqual([]);
  });
});
