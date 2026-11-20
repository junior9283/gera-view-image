import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo } from "../ipc/types";

const ipc = vi.hoisted(() => ({
  rev: 1,
  applyOp: vi.fn(),
  undo: vi.fn(),
  redo: vi.fn(),
}));
vi.mock("../ipc/commands", () => ({
  applyOp: ipc.applyOp,
  undo: ipc.undo,
  redo: ipc.redo,
}));

import { useDocs, resetDocsForTests } from "../store/docs";
import * as globalHistory from "../edit/history";
import { DEFAULT_STYLE, type Annotation } from "./model";
import { installHistory, resetHistoryForTests } from "./history";
import { addAnnotation, commit, deleteSelected, moveSelected, restyleSelected } from "./actions";
import { getItems, resetMarkupForTests, useMarkup } from "./store";

const info = (over: Partial<DocInfo> = {}): DocInfo => ({
  id: 1, path: "/a.png", name: "a.png", format: "png", width: 100, height: 80, frames: 1,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: ipc.rev, error: null, ...over,
});

const rect = (id: string): Annotation => ({ id, kind: "rect", geom: { x: 10, y: 10, w: 20, h: 20 }, style: { ...DEFAULT_STYLE } });

let uninstall: () => void;
beforeEach(() => {
  ipc.rev = 1;
    // Como o Rust: pilha de Op com desfazer/refazer.
    let done = 0;
    let undone = 0;
    const bump = () => info({ rev: ++ipc.rev, dirty: true, canUndo: done > 0, canRedo: undone > 0 });
    ipc.applyOp.mockImplementation(async () => ((done++, (undone = 0)), bump()));
    ipc.undo.mockImplementation(async () => ((done--, undone++), bump()));
    ipc.redo.mockImplementation(async () => ((done++, undone--), bump()));
  resetDocsForTests();
  useDocs.getState().add([info()]);
  resetMarkupForTests();
  resetHistoryForTests();
  uninstall = installHistory();
});
afterEach(() => {
  uninstall();
  vi.clearAllMocks();
});

describe("desfazer unificado", () => {
  it("mover anotação desfaz para a posição anterior", async () => {
    addAnnotation(1, rect("a"));
    useMarkup.getState().select(1, ["a"]);
    moveSelected(1, 15, 5);
    expect(getItems(1)[0].geom).toMatchObject({ x: 25, y: 15 });
    expect(globalHistory.canUndo(1)).toBe(true);
    await globalHistory.undo(1);
    expect(getItems(1)[0].geom).toMatchObject({ x: 10, y: 10 });
    await globalHistory.redo(1);
    expect(getItems(1)[0].geom).toMatchObject({ x: 25, y: 15 });
  });

  it("alterar estilo de várias selecionadas é um passo só", async () => {
    addAnnotation(1, rect("a"));
    addAnnotation(1, rect("b"));
    useMarkup.getState().select(1, ["a", "b"]);
    restyleSelected(1, { stroke: "#0000ff", width: 6 });
    expect(getItems(1).every((a) => a.style.stroke === "#0000ff" && a.style.width === 6)).toBe(true);
    await globalHistory.undo(1);
    expect(getItems(1).every((a) => a.style.stroke === DEFAULT_STYLE.stroke)).toBe(true);
    expect(getItems(1)).toHaveLength(2);
  });

  it("intercala anotações e Op na ordem em que aconteceram", async () => {
    addAnnotation(1, rect("a"));
    await useDocs.getState().applyOp(1, { type: "flipH" });
    addAnnotation(1, rect("b"));

    await globalHistory.undo(1); // tira "b"
    expect(getItems(1).map((a) => a.id)).toEqual(["a"]);
    expect(ipc.undo).not.toHaveBeenCalled();

    await globalHistory.undo(1); // desfaz o flipH no Rust
    expect(ipc.undo).toHaveBeenCalledTimes(1);
    expect(getItems(1).map((a) => a.id)).toEqual(["a"]);

    await globalHistory.undo(1); // tira "a"
    expect(getItems(1)).toEqual([]);
    expect(globalHistory.canUndo(1)).toBe(false);

    await globalHistory.redo(1);
    await globalHistory.redo(1);
    expect(ipc.redo).toHaveBeenCalledTimes(1);
    await globalHistory.redo(1);
    expect(getItems(1).map((a) => a.id)).toEqual(["a", "b"]);
    expect(globalHistory.canRedo(1)).toBe(false);
  });

  it("girar a imagem leva as anotações junto, no mesmo passo", async () => {
    addAnnotation(1, rect("a")); // 100x80, caixa (10,10,20,20)
    await useDocs.getState().applyOp(1, { type: "rotate", data: { quarterTurns: 1 } });
    expect(getItems(1)[0].geom).toEqual({ x: 50, y: 10, w: 20, h: 20 });
    await globalHistory.undo(1);
    expect(ipc.undo).toHaveBeenCalledTimes(1);
    expect(getItems(1)[0].geom).toEqual({ x: 10, y: 10, w: 20, h: 20 });
    await globalHistory.redo(1);
    expect(getItems(1)[0].geom).toEqual({ x: 50, y: 10, w: 20, h: 20 });
  });

  it("ação nova limpa o refazer", async () => {
    addAnnotation(1, rect("a"));
    await globalHistory.undo(1);
    expect(globalHistory.canRedo(1)).toBe(true);
    addAnnotation(1, rect("b"));
    expect(globalHistory.canRedo(1)).toBe(false);
  });

  it("Delete remove as selecionadas e desfaz devolvendo-as", async () => {
    addAnnotation(1, rect("a"));
    addAnnotation(1, rect("b"));
    useMarkup.getState().select(1, ["a"]);
    deleteSelected(1);
    expect(getItems(1).map((a) => a.id)).toEqual(["b"]);
    expect(useMarkup.getState().selected[1] ?? []).toEqual([]);
    await globalHistory.undo(1);
    expect(getItems(1).map((a) => a.id)).toEqual(["a", "b"]);
  });

  it("commit sem mudança não cria passo", () => {
    addAnnotation(1, rect("a"));
    const before = getItems(1);
    commit(1, before);
    commit(1, [...before]);
    expect(useMarkup.getState().docs[1]).toBe(before);
  });

  it("sem histórico próprio, cai nas Op do Rust", async () => {
    useDocs.getState().update(info({ rev: 99, canUndo: true }));
    expect(globalHistory.canUndo(1)).toBe(true);
    await globalHistory.undo(1);
    expect(ipc.undo).toHaveBeenCalledTimes(1);
    expect(globalHistory.canRedo(1)).toBe(true);
    await globalHistory.redo(1);
    expect(ipc.redo).toHaveBeenCalledTimes(1);
  });

  it("desinstalar devolve o provedor só de Op", async () => {
    uninstall();
    addAnnotation(1, rect("a"));
    expect(globalHistory.canUndo(1)).toBe(false);
    uninstall = installHistory();
  });
});
