import { describe, expect, it } from "vitest";
import { fitView, MAX_SCALE, zoomAt } from "./transform";

describe("transform", () => {
  it("zoom mantém o ponto sob o cursor fixo", () => {
    const v = { scale: 1, x: 10, y: 20 };
    const z = zoomAt(v, 2, 110, 120);
    // ponto da imagem sob o cursor antes e depois
    expect((110 - v.x) / v.scale).toBeCloseTo((110 - z.x) / z.scale);
    expect((120 - v.y) / v.scale).toBeCloseTo((120 - z.y) / z.scale);
  });

  it("limita a escala", () => {
    expect(zoomAt({ scale: 30, x: 0, y: 0 }, 100, 0, 0).scale).toBe(MAX_SCALE);
  });

  it("fit centraliza e não amplia", () => {
    expect(fitView(100, 50, 400, 400)).toEqual({ scale: 1, x: 150, y: 175 });
    expect(fitView(800, 400, 400, 400)).toEqual({ scale: 0.5, x: 0, y: 100 });
  });
});
