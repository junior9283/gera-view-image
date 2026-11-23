import { describe, expect, it, vi } from "vitest";

/** Tamanho (w×h) de cada cobertura rasterizada, para contar as da imagem inteira. */
const sizes = vi.hoisted(() => [] as number[]);
vi.mock("./lasso", async (orig) => {
  const m = await orig<typeof import("./lasso")>();
  return { ...m, rasterize: (mask: Mask, w: number, h: number) => (sizes.push(w * h), m.rasterize(mask, w, h)) };
});
import type { Mask } from "../ipc/types";
import { maskArea, maskBounds, rasterize } from "./lasso";
import { combineMasks, maskContains, modeFor, moveMask } from "./mask";

const W = 12;
const H = 10;
const rect = (x: number, y: number, w: number, h: number): Mask => ({ type: "rect", data: { x, y, w, h } });
const bitmap = (m: Mask): Mask => combineMasks(m, m, "add", W, H)!;
const inside = (m: Mask) => {
  const cov = rasterize(m, W, H);
  return (x: number, y: number) => cov[y * W + x] === 1;
};

describe("somar e subtrair seleções", () => {
  it("soma a união e subtrai a diferença", () => {
    const add = combineMasks(rect(0, 0, 4, 4), rect(6, 6, 2, 2), "add", W, H)!;
    expect(maskArea(add, W, H)).toBe(20);
    expect([inside(add)(1, 1), inside(add)(7, 7), inside(add)(5, 5)]).toEqual([true, true, false]);
    const sub = combineMasks(rect(0, 0, 4, 4), rect(1, 1, 2, 2), "subtract", W, H)!;
    expect(maskArea(sub, W, H)).toBe(12);
    expect([inside(sub)(0, 0), inside(sub)(1, 1)]).toEqual([true, false]);
  });

  it("subtrair tudo deixa sem seleção", () => {
    expect(combineMasks(rect(2, 2, 3, 3), rect(0, 0, 8, 8), "subtract", W, H)).toBeNull();
  });

  it("Shift soma e Alt subtrai só quando já há seleção", () => {
    const none = { shiftKey: false, altKey: false };
    expect(modeFor(rect(0, 0, 1, 1), none)).toBe("replace");
    expect(modeFor(rect(0, 0, 1, 1), { ...none, shiftKey: true })).toBe("add");
    expect(modeFor(rect(0, 0, 1, 1), { ...none, altKey: true })).toBe("subtract");
    expect(modeFor(null, { ...none, shiftKey: true })).toBe("replace");
    expect(modeFor(null, { ...none, altKey: true })).toBe("replace");
  });
});

describe("somar e subtrair sem duas coberturas da imagem inteira", () => {
  const poly: Mask = { type: "polygon", data: [[1, 1], [10, 2], [6, 9]] };
  const others: Record<string, Mask> = {
    retângulo: rect(-3, 5, 8, 9),
    elipse: { type: "ellipse", data: { x: 4, y: -2, w: 9, h: 7 } },
    polígono: { type: "polygon", data: [[0, 9], [11, 0], [11, 9]] },
    bitmap: bitmap(rect(2, 3, 5, 4)),
  };
  it.each(Object.keys(others))("%s: mesmo resultado, uma cobertura w×h só", (name) => {
    for (const mode of ["add", "subtract"] as const) {
      const [a, b] = [rasterize(poly, W, H), rasterize(others[name], W, H)];
      const want = a.map((v, i) => (mode === "add" ? v | b[i] : v & (b[i] ^ 1)));
      sizes.length = 0;
      const got = combineMasks(poly, others[name], mode, W, H)!;
      expect(sizes.filter((n) => n === W * H), mode).toHaveLength(1);
      expect([...rasterize(got, W, H)], mode).toEqual([...want]);
    }
  });
});

describe("mover a seleção", () => {
  it("retângulo e elipse andam e param na borda", () => {
    expect(moveMask(rect(2, 2, 3, 3), 2, 1, W, H)).toEqual(rect(4, 3, 3, 3));
    expect(moveMask(rect(2, 2, 3, 3), 50, -50, W, H)).toEqual(rect(9, 0, 3, 3));
  });

  it("polígono leva todos os pontos", () => {
    const p: Mask = { type: "polygon", data: [[1, 1], [5, 1], [5, 4]] };
    expect(moveMask(p, 2, 3, W, H)).toEqual({ type: "polygon", data: [[3, 4], [7, 4], [7, 7]] });
    expect(moveMask(p, -9, 0, W, H)).toEqual({ type: "polygon", data: [[0, 1], [4, 1], [4, 4]] });
  });

  it("máscara livre (bitmap) anda sem perder nem dar a volta nos pixels", () => {
    const m = bitmap({ type: "polygon", data: [[2, 2], [8, 3], [4, 7]] });
    const area = maskArea(m, W, H);
    const from = maskBounds(m, W, H)!;
    for (const [dx, dy] of [[1, 0], [0, 2], [-2, -1], [99, 99], [-99, -99], [3, -99]]) {
      const moved = moveMask(m, dx, dy, W, H);
      expect(maskArea(moved, W, H)).toBe(area);
      const b = maskBounds(moved, W, H)!;
      expect([b.w, b.h]).toEqual([from.w, from.h]);
      const x = Math.min(W - from.w, Math.max(0, from.x + dx));
      const y = Math.min(H - from.h, Math.max(0, from.y + dy));
      expect([b.x, b.y]).toEqual([x, y]);
    }
  });

  it("o que já ocupa a imagem inteira não anda", () => {
    const all = rect(0, 0, W, H);
    expect(moveMask(all, 3, 3, W, H)).toBe(all);
  });
});

describe("ponto dentro da seleção", () => {
  it("concorda com a rasterização em todos os tipos", () => {
    const masks: Mask[] = [
      rect(2, 1, 4, 5),
      { type: "ellipse", data: { x: 2, y: 1, w: 7, h: 6 } },
      { type: "polygon", data: [[1, 1], [10, 2], [5, 9]] },
      bitmap({ type: "polygon", data: [[1, 1], [10, 2], [5, 9]] }),
    ];
    for (const m of masks) {
      const at = inside(m);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) expect(maskContains(m, x + 0.5, y + 0.5), `${m.type} ${x},${y}`).toBe(at(x, y));
    }
  });

  it("fora da imagem é fora", () => {
    expect(maskContains(bitmap(rect(0, 0, W, H)), -0.5, 3)).toBe(false);
    expect(maskContains(bitmap(rect(0, 0, W, H)), W + 0.5, 3)).toBe(false);
  });
});
