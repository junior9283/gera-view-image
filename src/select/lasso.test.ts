import { describe, expect, it } from "vitest";
import type { Mask } from "../ipc/types";
import { invertMask, maskArea, maskBounds, rasterize, sampleBitmap, simplifyPath, type Point } from "./lasso";

describe("simplifyPath (Ramer-Douglas-Peucker)", () => {
  it("reduz uma linha reta de 100 pontos a 2", () => {
    const linha: Point[] = Array.from({ length: 100 }, (_, i) => [i, 2 * i]);
    expect(simplifyPath(linha, 0.5)).toEqual([[0, 0], [99, 198]]);
  });

  it("mantém o vértice de um L", () => {
    const l: Point[] = [[0, 0], [5, 0], [10, 0], [10, 5], [10, 10]];
    expect(simplifyPath(l, 0.5)).toEqual([[0, 0], [10, 0], [10, 10]]);
  });

  it("não mexe em caminhos curtos", () => {
    expect(simplifyPath([[1, 1]], 1)).toEqual([[1, 1]]);
    expect(simplifyPath([[1, 1], [2, 2]], 1)).toEqual([[1, 1], [2, 2]]);
  });
});

describe("máscaras", () => {
  const rect: Mask = { type: "rect", data: { x: 2, y: 1, w: 3, h: 2 } };

  it("rasteriza retângulo, elipse e polígono", () => {
    expect(maskArea(rect, 10, 5)).toBe(6);
    const elipse: Mask = { type: "ellipse", data: { x: 0, y: 0, w: 10, h: 10 } };
    const a = maskArea(elipse, 10, 10);
    expect(a).toBeGreaterThan(60);
    expect(a).toBeLessThan(90);
    const tri: Mask = { type: "polygon", data: [[0, 0], [10, 0], [0, 10]] };
    expect(maskArea(tri, 10, 10)).toBeGreaterThan(40);
  });

  it("invertMask(Rect) devolve Bitmap com a contagem complementar", () => {
    const inv = invertMask(rect, 10, 5);
    expect(inv.type).toBe("bitmap");
    expect(maskArea(inv, 10, 5)).toBe(50 - 6);
    const cov = rasterize(inv, 10, 5);
    expect(cov[1 * 10 + 2]).toBe(0);
    expect(cov[0]).toBe(1);
  });

  it("inverter duas vezes volta à cobertura original", () => {
    const twice = invertMask(invertMask(rect, 10, 5), 10, 5);
    expect(Array.from(rasterize(twice, 10, 5))).toEqual(Array.from(rasterize(rect, 10, 5)));
  });

  it("o RLE do Bitmap começa por uma corrida 'fora'", () => {
    const m = invertMask({ type: "rect", data: { x: 0, y: 0, w: 2, h: 1 } }, 4, 1);
    expect(m).toEqual({ type: "bitmap", data: { w: 4, h: 1, rle: [2, 2] } });
  });

  it("sampleBitmap amostra a grade sem expandir a máscara", () => {
    const inv = invertMask({ type: "rect", data: { x: 0, y: 0, w: 4, h: 4 } }, 8, 8);
    if (inv.type !== "bitmap") throw new Error("esperava bitmap");
    const { cells, tw, th, step } = sampleBitmap(inv, 4); // step 2 → grade 4x4
    expect([tw, th, step]).toEqual([4, 4, 2]);
    expect(Array.from(cells)).toEqual([0, 0, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it("maskBounds", () => {
    expect(maskBounds(rect, 10, 5)).toEqual({ x: 2, y: 1, w: 3, h: 2 });
    expect(maskBounds({ type: "rect", data: { x: 0, y: 0, w: 0, h: 0 } }, 10, 5)).toBeNull();
  });
});
