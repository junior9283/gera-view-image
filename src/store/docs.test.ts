import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo } from "../ipc/types";

const invoke = vi.fn();
const order: string[] = [];
let emit: ((e: { payload: DocInfo }) => void) | null = null;
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, ...a: unknown[]) => {
    order.push(cmd);
    return invoke(cmd, ...a);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: (e: { payload: DocInfo }) => void) => {
    order.push(`listen:${name}`);
    emit = cb;
    return () => {};
  },
}));

import { initDocs, resetDocsForTests, useDocs } from "./docs";

const info = (id: number, extra: Partial<DocInfo> = {}): DocInfo => ({
  id, path: `/x/${id}.png`, name: `${id}.png`, format: "png", width: 10, height: 10, frames: 1,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 0, error: null, ...extra,
});

describe("store de documentos", () => {
  beforeEach(() => {
    invoke.mockReset();
    order.length = 0;
    resetDocsForTests();
  });

  it("open acrescenta os documentos e ativa o primeiro aberto", async () => {
    invoke.mockResolvedValue([info(1), info(2, { error: "corrupt" })]);
    await useDocs.getState().open(["/x/1.png", "/x/2.png"]);
    expect(invoke).toHaveBeenCalledWith("open_documents", { paths: ["/x/1.png", "/x/2.png"] });
    expect(useDocs.getState().docs.map((d) => d.id)).toEqual([1, 2]);
    expect(useDocs.getState().activeId).toBe(1);
  });

  it("detach tira sem fechar no Rust e ativa o seguinte que ficou, ou o último", () => {
    const left = (ids: number[], active: number) => {
      useDocs.setState({ docs: [1, 2, 3, 4].map((i) => info(i)), activeId: active });
      useDocs.getState().detach(ids);
      const { docs, activeId } = useDocs.getState();
      return [docs.map((d) => d.id), activeId];
    };
    expect(left([2], 2)).toEqual([[1, 3, 4], 3]);
    expect(left([2, 3], 2)).toEqual([[1, 4], 4]);
    expect(left([3, 4], 4)).toEqual([[1, 2], 2]);
    expect(left([2], 1)).toEqual([[1, 3, 4], 1]);
    expect(left([1, 2, 3, 4], 2)).toEqual([[], null]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("applyOp, undo e redo substituem o DocInfo pelo devolvido", async () => {
    useDocs.setState({ docs: [info(1)], activeId: 1 });
    invoke.mockResolvedValue(info(1, { dirty: true, canUndo: true, rev: 1 }));
    await useDocs.getState().applyOp(1, { type: "flipH" });
    expect(useDocs.getState().docs[0].dirty).toBe(true);
    invoke.mockResolvedValue(info(1, { canRedo: true, rev: 2 }));
    await useDocs.getState().undo(1);
    expect(invoke).toHaveBeenLastCalledWith("undo", { id: 1 });
    expect(useDocs.getState().docs[0].canRedo).toBe(true);
    invoke.mockResolvedValue(info(1, { dirty: true, rev: 3 }));
    await useDocs.getState().redo(1);
    expect(useDocs.getState().docs[0].rev).toBe(3);
  });

  it("update ignora revisão antiga e setActive troca o ativo", () => {
    useDocs.setState({ docs: [info(1, { rev: 5 }), info(2)], activeId: 1 });
    useDocs.getState().update(info(1, { rev: 4, width: 99 }));
    expect(useDocs.getState().docs[0].width).toBe(10);
    useDocs.getState().setActive(2);
    expect(useDocs.getState().activeId).toBe(2);
  });

  it("add ignora documentos já presentes (StrictMode chama a inicialização duas vezes)", () => {
    useDocs.getState().add([info(1), info(2)]);
    useDocs.getState().add([info(2), info(3)]);
    expect(useDocs.getState().docs.map((d) => d.id)).toEqual([1, 2, 3]);
  });

  it("update que chega antes do add não se perde", () => {
    useDocs.getState().update(info(7, { rev: 3, width: 4000 }));
    useDocs.getState().add([info(7, { rev: 1 })]);
    expect(useDocs.getState().docs[0]).toMatchObject({ id: 7, rev: 3, width: 4000 });
  });

  it("reorder move o documento para a nova posição", () => {
    useDocs.getState().add([info(1), info(2), info(3)]);
    useDocs.getState().reorder(3, 0);
    expect(useDocs.getState().docs.map((d) => d.id)).toEqual([3, 1, 2]);
    useDocs.getState().reorder(3, 2);
    expect(useDocs.getState().docs.map((d) => d.id)).toEqual([1, 2, 3]);
  });

  it("applyOrder segue a lista, deixa os ausentes no fim e não troca o estado se nada muda", () => {
    useDocs.getState().add([info(1), info(2), info(3)]);
    useDocs.getState().applyOrder([3, 1]);
    expect(useDocs.getState().docs.map((d) => d.id)).toEqual([3, 1, 2]);
    const before = useDocs.getState().docs;
    useDocs.getState().applyOrder([3, 1, 2]);
    expect(useDocs.getState().docs).toBe(before);
  });

  it("close fecha no Rust, remove e ativa o vizinho", async () => {
    useDocs.getState().add([info(1), info(2), info(3)]);
    useDocs.getState().setActive(2);
    invoke.mockResolvedValue(undefined);
    await useDocs.getState().close(2);
    expect(invoke).toHaveBeenCalledWith("close_document", { id: 2 });
    expect(useDocs.getState().docs.map((d) => d.id)).toEqual([1, 3]);
    expect(useDocs.getState().activeId).toBe(3);
    await useDocs.getState().close(3);
    expect(useDocs.getState().activeId).toBe(1);
    await useDocs.getState().close(1);
    expect(useDocs.getState().activeId).toBeNull();
  });

  it("initDocs registra o listener antes de buscar os documentos e roda uma vez só", async () => {
    invoke.mockResolvedValue([info(1), info(2)]);
    await Promise.all([initDocs(), initDocs()]);
    expect(order).toEqual(["listen:doc-updated", "startup_documents"]);
    expect(useDocs.getState().docs.map((d) => d.id)).toEqual([1, 2]);
    emit!({ payload: info(2, { rev: 9, error: "corrupt" }) });
    expect(useDocs.getState().docs[1]).toMatchObject({ rev: 9, error: "corrupt" });
  });
});
