import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo } from "../ipc/types";

const ipc = vi.hoisted(() => ({ rev: 1, applyOp: vi.fn(), undo: vi.fn(), redo: vi.fn(), renderView: vi.fn() }));
vi.mock("../ipc/commands", () => ipc);

import { useDocs, resetDocsForTests } from "../store/docs";
import * as globalHistory from "../edit/history";
import { DEFAULT_STYLE, type Annotation } from "./model";
import { flattenToPng, render } from "./render";
import { flattenAnnotations } from "./flatten";
import { installHistory, resetHistoryForTests } from "./history";
import { addAnnotation } from "./actions";
import { getItems, resetMarkupForTests } from "./store";

type Call = [string, ...unknown[]];

/** Contexto 2D falso: grava cada chamada de método e aceita qualquer propriedade. */
function mockCtx() {
  const calls: Call[] = [];
  const target: Record<string | symbol, unknown> = { calls, canvas: {} };
  return new Proxy(target, {
    get(t, p) {
      if (p in t) return t[p];
      const fn = (...args: unknown[]) => {
        calls.push([String(p), ...args]);
        if (p === "measureText") return { width: String(args[0]).length * 8 };
        if (p === "getLineDash") return [];
        return undefined;
      };
      t[p] = fn;
      return fn;
    },
  }) as unknown as CanvasRenderingContext2D & { calls: Call[] };
}

/** PNG mínimo (assinatura + IHDR) com o tamanho do canvas, como o navegador faria. */
function fakePng(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, w);
  dv.setUint32(20, h);
  return b;
}

let lastCtx: ReturnType<typeof mockCtx> | null = null;
class FakeOffscreen {
  constructor(public width: number, public height: number) {}
  getContext() {
    lastCtx = mockCtx();
    return lastCtx;
  }
  async convertToBlob() {
    return new Blob([fakePng(this.width, this.height) as BlobPart], { type: "image/png" });
  }
}

const arrow: Annotation = {
  id: "a",
  kind: "arrow",
  geom: { x1: 10, y1: 20, x2: 90, y2: 20 },
  style: { ...DEFAULT_STYLE, stroke: "#ff0000", width: 4, arrowEnd: "arrow" },
};

beforeEach(() => {
  vi.stubGlobal("OffscreenCanvas", FakeOffscreen);
  lastCtx = null;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("render", () => {
  it("desenha a seta com a cor e espessura do traço, em coordenadas de tela", () => {
    const ctx = mockCtx();
    render(ctx, [arrow], { scale: 2, panX: 5, panY: 7 }, null, { imageW: 100, imageH: 50, dpr: 1 });
    expect(ctx.calls).toContainEqual(["setTransform", 2, 0, 0, 2, 5, 7]);
    expect(ctx.calls.some(([m, x, y]) => m === "moveTo" && x === 10 && y === 20)).toBe(true);
    expect(ctx.calls.some(([m, x, y]) => m === "lineTo" && x === 90 && y === 20)).toBe(true);
    expect(ctx.strokeStyle).toBe("#ff0000");
  });

  it("realce escurece o resto da imagem em 50 % e os realces se somam na mesma máscara", () => {
    const ctx = mockCtx();
    const sets: [string, unknown][] = [];
    const spy = new Proxy(ctx, {
      set(t, p, v) {
        sets.push([String(p), v]);
        (t as unknown as Record<string, unknown>)[p as string] = v;
        return true;
      },
    });
    const hl = (id: string, x: number, shape: "rect" | "oval"): Annotation => ({ id, kind: "highlight", geom: { x, y: 10, w: 20, h: 20, shape }, style: DEFAULT_STYLE });
    render(spy, [hl("h1", 10, "rect"), hl("h2", 20, "oval")], { scale: 1, panX: 0, panY: 0 }, null, { imageW: 100, imageH: 50, dpr: 1 });
    // Uma camada escura só, depois os realces recortados dela (destination-out).
    expect(ctx.calls.filter(([m]) => m === "fillRect")).toEqual([["fillRect", 0, 0, 100, 50]]);
    expect(sets).toContainEqual(["fillStyle", "rgba(0,0,0,0.5)"]);
    expect(sets).toContainEqual(["globalCompositeOperation", "destination-out"]);
    expect(ctx.calls).toContainEqual(["rect", 10, 10, 20, 20]);
    expect(ctx.calls).toContainEqual(["ellipse", 30, 20, 10, 10, 0, 0, Math.PI * 2]);
  });

  it("lupa amplia os pixels da fonte dentro do círculo", () => {
    const ctx = mockCtx();
    const src = { image: {} as CanvasImageSource, w: 50, h: 25 }; // fonte em meia resolução
    const z: Annotation = { id: "z", kind: "loupe", geom: { cx: 40, cy: 20, r: 10, zoom: 2 }, style: DEFAULT_STYLE };
    render(ctx, [z], { scale: 1, panX: 0, panY: 0 }, src, { imageW: 100, imageH: 50, dpr: 1 });
    expect(ctx.calls).toContainEqual(["clip"]);
    // Área de 10x10 px da imagem (20/2) em torno de (40,20) → na fonte (meia resolução): 5x5 a partir de (17.5, 7.5).
    expect(ctx.calls).toContainEqual(["drawImage", src.image, 17.5, 7.5, 5, 5, 30, 10, 20, 20]);
  });
});

describe("flattenToPng", () => {
  it("gera PNG do tamanho da imagem", async () => {
    const png = await flattenToPng([arrow], 320, 200, null);
    expect(Array.from(png.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const dv = new DataView(png.buffer, png.byteOffset);
    expect([dv.getUint32(16), dv.getUint32(20)]).toEqual([320, 200]);
    expect(lastCtx!.calls).toContainEqual(["setTransform", 1, 0, 0, 1, 0, 0]);
    expect(lastCtx!.calls.some(([m]) => m === "stroke")).toBe(true);
  });
});

describe("flattenAnnotations", () => {
  const info = (over: Partial<DocInfo> = {}): DocInfo => ({
    id: 1, path: "/a.png", name: "a.png", format: "png", width: 320, height: 200, frames: 1,
    writable: true, dirty: false, canUndo: false, canRedo: false, rev: ipc.rev, error: null, ...over,
  });
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
  afterEach(() => uninstall());

  it("achata com Op::Composite, limpa as anotações e o desfazer as devolve", async () => {
    addAnnotation(1, arrow);
    expect(await flattenAnnotations(1)).toBe(true);
    expect(ipc.applyOp).toHaveBeenCalledTimes(1);
    const [id, op] = ipc.applyOp.mock.calls[0];
    expect(id).toBe(1);
    expect(op.type).toBe("composite");
    expect(op.data.png).toBeInstanceOf(Uint8Array);
    expect(getItems(1)).toEqual([]);
    expect(useDocs.getState().docs[0].rev).toBe(2);

    await globalHistory.undo(1);
    expect(ipc.undo).toHaveBeenCalledTimes(1);
    expect(getItems(1).map((a) => a.id)).toEqual(["a"]);
  });

  it("sem anotações não faz nada", async () => {
    expect(await flattenAnnotations(1)).toBe(false);
    expect(ipc.applyOp).not.toHaveBeenCalled();
  });
});
