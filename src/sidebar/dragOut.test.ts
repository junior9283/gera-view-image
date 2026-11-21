import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo } from "../ipc/types";

const ipc = vi.hoisted(() => ({ startDrag: vi.fn<(...a: unknown[]) => Promise<void>>() }));
vi.mock("../ipc/commands", () => ipc);

import { dragItems, dragPlan, draggingOut, isOutside, startDragOut } from "./dragOut";

const info = (id: number, extra: Partial<DocInfo> = {}): DocInfo => ({
  id, path: `/p/${id}.png`, name: `${id}.png`, format: "png", width: 10, height: 10, frames: 1,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 0, error: null, ...extra,
});

describe("isOutside", () => {
  const win = { innerWidth: 800, innerHeight: 600 };
  it("dentro da janela é arraste interno", () => {
    expect(isOutside({ clientX: 10, clientY: 10 }, win)).toBe(false);
    expect(isOutside({ clientX: 798, clientY: 598 }, win)).toBe(false);
  });
  it("na borda ou além dela é arraste para fora", () => {
    expect(isOutside({ clientX: -1, clientY: 10 }, win)).toBe(true);
    expect(isOutside({ clientX: 0, clientY: 10 }, win)).toBe(true);
    expect(isOutside({ clientX: 10, clientY: 600 }, win)).toBe(true);
    expect(isOutside({ clientX: 900, clientY: 10 }, win)).toBe(true);
    expect(isOutside({ clientX: 10, clientY: -5 }, win)).toBe(true);
  });
});

describe("dragItems", () => {
  const docs = [info(1), info(2), info(3), info(4, { error: "corrupt" })];
  it("sem seleção múltipla, arrasta só a miniatura pressionada", () => {
    expect(dragItems(docs, new Set(), 2).map((d) => d.id)).toEqual([2]);
    expect(dragItems(docs, new Set([2]), 2).map((d) => d.id)).toEqual([2]);
  });
  it("pressionada fora da seleção ignora a seleção", () => {
    expect(dragItems(docs, new Set([1, 3]), 2).map((d) => d.id)).toEqual([2]);
  });
  it("pressionada dentro da seleção arrasta todas, na ordem da barra", () => {
    expect(dragItems(docs, new Set([3, 1]), 3).map((d) => d.id)).toEqual([1, 3]);
  });
  it("deixa de fora documentos que não abriram (e ids já fechados)", () => {
    expect(dragItems(docs, new Set([1, 4, 99]), 1).map((d) => d.id)).toEqual([1]);
    expect(dragItems(docs, new Set(), 4)).toEqual([]);
  });
});

describe("dragPlan", () => {
  it("documento salvo vai pelo arquivo; alterado ou sem caminho vira PNG temporário", () => {
    const unsaved = new Set([3]);
    const plan = dragPlan(
      [info(1), info(2, { dirty: true }), info(3), info(5, { path: "" })],
      (d) => d.dirty || unsaved.has(d.id),
    );
    expect(plan).toEqual([
      { id: 1, export: false },
      { id: 2, export: true },
      { id: 3, export: true },
      { id: 5, export: true },
    ]);
  });
});

describe("startDragOut", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ipc.startDrag.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("marca o arraste enquanto ele dura e um pouco depois (o drop na própria janela chega depois)", async () => {
    let finish!: () => void;
    ipc.startDrag.mockImplementation(() => new Promise<void>((r) => (finish = r)));
    const p = startDragOut([{ id: 1, export: false }]);
    expect(ipc.startDrag).toHaveBeenCalledWith([{ id: 1, export: false }]);
    expect(draggingOut()).toBe(true);
    finish();
    await p;
    expect(draggingOut()).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(draggingOut()).toBe(false);
  });

  it("lista vazia não chama o Rust", async () => {
    await startDragOut([]);
    expect(ipc.startDrag).not.toHaveBeenCalled();
    expect(draggingOut()).toBe(false);
  });

  it("erro do Rust não deixa a marca presa", async () => {
    ipc.startDrag.mockRejectedValue(new Error("x"));
    await expect(startDragOut([{ id: 1, export: true }])).rejects.toThrow("x");
    await vi.advanceTimersByTimeAsync(1000);
    expect(draggingOut()).toBe(false);
  });
});
