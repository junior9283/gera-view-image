import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo } from "../ipc/types";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { useDocs } from "./docs";

const info = (id: number, extra: Partial<DocInfo> = {}): DocInfo => ({
  id, path: `/x/${id}.png`, name: `${id}.png`, format: "png", width: 10, height: 10, frames: 1,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 0, error: null, ...extra,
});

describe("store de documentos", () => {
  beforeEach(() => {
    invoke.mockReset();
    useDocs.setState({ docs: [], activeId: null });
  });

  it("open acrescenta os documentos e ativa o primeiro aberto", async () => {
    invoke.mockResolvedValue([info(1), info(2, { error: "corrupt" })]);
    await useDocs.getState().open(["/x/1.png", "/x/2.png"]);
    expect(invoke).toHaveBeenCalledWith("open_documents", { paths: ["/x/1.png", "/x/2.png"] });
    expect(useDocs.getState().docs.map((d) => d.id)).toEqual([1, 2]);
    expect(useDocs.getState().activeId).toBe(1);
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
});
