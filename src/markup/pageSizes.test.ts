// TIFF de páginas com tamanhos diferentes: tudo usa o tamanho da página exibida, e cada edição vai
// só para ela. Das ações da interface até o `invoke`, sem simular o `ipc`.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo, Op } from "../ipc/types";

type Args = Record<string, unknown> & { id: number };
const invoke = vi.hoisted(() => vi.fn<(cmd: string, args: never) => Promise<unknown>>());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onCloseRequested: vi.fn(async () => () => {}) }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
const flat = vi.hoisted(() => vi.fn<(...a: unknown[]) => Promise<Uint8Array>>(async () => new Uint8Array([1])));
vi.mock("./render", async (orig) => ({ ...(await orig<typeof import("./render")>()), flattenToPng: flat }));

import * as ipc from "../ipc/commands";
import { cropToSelection, deleteSelection, invertSelection, selectAll } from "../select/actions";
import "../select/register";
import { applyToTargets } from "../sidebar/batch";
import { useDocs } from "../store/docs";
import { useSelection } from "../store/selection";
import { resetUiForTests, useUi } from "../store/ui";
import { copySubject, removeBackground } from "../subject/actions";
import { actualSize, fitToWindow, syncView } from "../viewer/actions";
import { duplicateAnnotations, pasteAnnotations } from "./clipboard";
import { flattenAnnotations } from "./flatten";
import { pushMarkup, resetHistoryForTests } from "./history";
import { DEFAULT_STYLE, serialize, type Annotation } from "./model";
import "./register";
import { getItems, resetMarkupForTests, useMarkup } from "./store";

const tiff: DocInfo = {
  id: 5, path: "/f/t.tiff", name: "t.tiff", format: "tiff", width: 40, height: 30, frames: 3,
  pageSizes: [[40, 30], [60, 80], [10, 12]],
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 1, error: null,
};
const png: DocInfo = { ...tiff, id: 6, path: "/f/p.png", name: "p.png", format: "png", frames: 1, pageSizes: [] };
const gif: DocInfo = { ...png, id: 7, path: "/f/a.gif", name: "a.gif", format: "gif", frames: 3, delaysMs: [50, 50, 50] };
const rect = (id: string, page?: number): Annotation =>
  ({ id, kind: "rect", geom: { x: 1, y: 2, w: 3, h: 4 }, style: DEFAULT_STYLE, ...(page ? { page } : {}) }) as Annotation;
const calls = (cmd: string) => invoke.mock.calls.filter(([c]) => c === cmd).map(([, a]) => a as unknown as Args);
const sel = () => useSelection.getState();
const mask = { type: "bitmap" as const, data: { w: 60, h: 80, rle: [0, 10, 4790] } };

let rev = 1;
beforeEach(() => {
  rev = 1;
  resetMarkupForTests();
  resetHistoryForTests();
  resetUiForTests();
  flat.mockClear();
  useUi.setState({ viewSize: { w: 400, h: 400 }, page: 1 });
  useDocs.setState({ docs: [tiff, png, gif], activeId: 5 });
  sel().setSelection(null);
  invoke.mockReset().mockImplementation(async (cmd, args) => {
    const a = args as unknown as Args;
    if (cmd === "segment_model_ready") return true;
    if (cmd === "segment_subject") return mask;
    const base = useDocs.getState().docs.find((d) => d.id === a?.id);
    return cmd === "apply_op" ? { ...base, rev: ++rev } : null;
  });
});

describe("tamanho da página exibida", () => {
  it("Ajustar e Tamanho Real usam a página exibida, não a primeira", () => {
    syncView(true);
    fitToWindow();
    // 60x80 cabe inteira; centrada na área de 400x400.
    const v = useUi.getState().view!;
    expect(v.panX).toBeCloseTo((400 - 60 * v.scale) / 2);
    expect(v.panY).toBeCloseTo((400 - 80 * v.scale) / 2);
    actualSize();
    expect(useUi.getState().view!.panX).toBeCloseTo((400 - 60 * useUi.getState().view!.scale) / 2);
  });

  it("Selecionar Tudo e Inverter usam o tamanho da página", () => {
    selectAll();
    expect(sel().selection).toEqual({ type: "rect", data: { x: 0, y: 0, w: 60, h: 80 } });
    sel().setSelection({ type: "rect", data: { x: 0, y: 0, w: 60, h: 40 } });
    invertSelection();
    expect(sel().selection?.type).toBe("bitmap");
    expect((sel().selection as typeof mask).data).toMatchObject({ w: 60, h: 80 });
    // Documento de uma página: como sempre.
    useDocs.getState().setActive(6);
    selectAll();
    expect(sel().selection).toEqual({ type: "rect", data: { x: 0, y: 0, w: 40, h: 30 } });
  });

  it("a seleção some ao trocar de página, e fica ao trocar de quadro de uma animação", () => {
    selectAll();
    useUi.getState().setPage(2);
    expect(sel().selection).toBeNull();
    useDocs.getState().setActive(7);
    selectAll();
    useUi.getState().setPage(1);
    expect(sel().selection).not.toBeNull();
  });

  it("achatar desenha no tamanho da página das anotações", async () => {
    useMarkup.getState().setItems(5, [rect("a"), rect("b", 1)]);
    await flattenAnnotations(5, 1);
    expect(flat).toHaveBeenLastCalledWith([expect.objectContaining({ id: "b" })], 60, 80, null);
  });

  it("achatar todas as páginas (Salvar TIFF) manda uma camada por página", async () => {
    useMarkup.getState().setItems(5, [rect("a"), rect("b", 1)]);
    await flattenAnnotations(5, null);
    expect(flat.mock.calls.map((c) => c.slice(1, 3))).toEqual([[40, 30], [60, 80]]);
    expect(calls("apply_op").map((a) => (a.op as { data: { frame: number } }).data.frame)).toEqual([0, 1]);
    expect(getItems(5)).toEqual([]);
  });

  it("colar numa página menor que a primeira centra a anotação dentro dela", async () => {
    // Cabe na primeira página (40x30), mas fica fora da terceira (10x12).
    const copied = { ...rect("c"), geom: { x: 35, y: 20, w: 3, h: 4 } } as Annotation;
    const reply = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (cmd, args) => (cmd === "pasted_annotations" ? serialize({ items: [copied] }) : reply(cmd, args)));
    useUi.setState({ page: 2 });
    expect(await pasteAnnotations()).toBe(true);
    const [pasted] = getItems(5);
    expect(pasted).toMatchObject({ page: 2, geom: { x: 3.5, y: 4, w: 3, h: 4 } });
    // Na página maior (60x80), o que cabe nela fica onde estava, sem ir para o centro.
    resetMarkupForTests();
    useUi.setState({ page: 1 });
    useMarkup.getState().setItems(5, [{ ...rect("d", 1), geom: { x: 45, y: 50, w: 3, h: 4 } } as Annotation]);
    useMarkup.getState().select(5, ["d"]);
    duplicateAnnotations(5);
    const dup = getItems(5)[1];
    expect(dup.page).toBe(1);
    expect((dup.geom as { x: number }).x).toBeGreaterThan(45);
  });
});

describe("cada edição vale só para a página exibida", () => {
  const frames = () => calls("apply_op").map((a) => [a.id, (a.op as Op).type, a.frame]);

  it("Recortar, Apagar, Girar e Remover Fundo levam a página", async () => {
    sel().setSelection({ type: "rect", data: { x: 45, y: 50, w: 10, h: 20 } });
    await cropToSelection();
    expect(calls("apply_op")[0].op).toMatchObject({ type: "crop", data: { x: 45, y: 50, w: 10, h: 20 } });
    sel().setSelection({ type: "rect", data: { x: 1, y: 1, w: 1, h: 1 } });
    await deleteSelection();
    await applyToTargets([5], () => ({ type: "flipH" }));
    await removeBackground();
    expect(frames()).toEqual([[5, "crop", 1], [5, "erase", 1], [5, "flipH", 1], [5, "makeTransparent", 1]]);
    expect(calls("segment_subject")).toEqual([{ id: 5, frame: 1 }]);
  });

  it("a primeira página também vai explícita", async () => {
    useUi.setState({ page: null });
    await useDocs.getState().applyOp(5, { type: "flipV" });
    expect(frames()).toEqual([[5, "flipV", 0]]);
  });

  it("documento de uma página ou animação não leva página; lote fora do ativo usa a primeira", async () => {
    useDocs.getState().setActive(6);
    await applyToTargets([6, 7, 5], () => ({ type: "flipH" }));
    expect(frames()).toEqual([[6, "flipH", undefined], [7, "flipH", undefined], [5, "flipH", 0]]);
  });

  it("Copiar Objeto e a máscara usam a página; trocar de página no meio descarta a máscara", async () => {
    await copySubject();
    expect(calls("copy_region")).toEqual([{ id: 5, mask, frame: 1 }]);
    sel().setSelection(null);
    const reply = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "segment_subject") useUi.getState().setPage(2);
      return reply(cmd, args);
    });
    await removeBackground();
    expect(frames()).toEqual([]);
  });

  it("girar leva só as anotações da página, pelo tamanho dela", async () => {
    useMarkup.getState().setItems(5, [rect("a"), rect("b", 1)]);
    pushMarkup(5, [], getItems(5));
    await useDocs.getState().applyOp(5, { type: "rotate", data: { quarterTurns: 1 } });
    const [a, b] = getItems(5);
    expect(a).toEqual(rect("a"));
    // (x, y) -> (altura - y - h, x) com a altura da página 2 (80).
    expect(b).toMatchObject({ id: "b", page: 1, geom: { x: 74, y: 1, w: 4, h: 3 } });
  });
});

describe("IPC", () => {
  it("as ferramentas mandam a página; sem ela, nada muda no pedido", async () => {
    invoke.mockResolvedValue({ type: "rect", data: { x: 0, y: 0, w: 1, h: 1 } });
    await ipc.instantAlpha(5, 1, 2, 0.5, 2);
    await ipc.snapLasso(5, [[0, 0]], 2);
    await ipc.histogram(5, 2);
    await ipc.autoLevels(5, 2);
    await ipc.metadata(5, 2);
    await ipc.documentDpi(5, 2);
    for (const c of ["instant_alpha", "snap_lasso", "histogram", "auto_levels", "metadata", "document_dpi"]) {
      expect(calls(c)[0], c).toMatchObject({ id: 5, frame: 2 });
    }
    await ipc.histogram(6);
    expect(calls("histogram")[1]).toEqual({ id: 6 });
  });
});
