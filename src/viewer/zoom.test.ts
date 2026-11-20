import { describe, expect, it } from "vitest";
import { clampPan, fitScale, fitState, nextStep, visibleRegion, zoomAt, ZOOM_STEPS, type ViewState } from "./zoom";

/** Ponto da imagem sob o ponto (x, y) da tela. */
const imagePoint = (s: ViewState, x: number, y: number) => ({ x: (x - s.panX) / s.scale, y: (y - s.panY) / s.scale });

describe("zoom", () => {
  it("fitScale reduz a imagem grande para caber", () => {
    expect(fitScale({ w: 4000, h: 3000 }, { w: 800, h: 600 })).toBe(0.2);
  });

  it("fitScale imagem menor não amplia", () => {
    expect(fitScale({ w: 100, h: 50 }, { w: 800, h: 600 })).toBe(1);
    expect(fitScale({ w: 100, h: 50 }, { w: 800, h: 600 }, true)).toBe(8);
  });

  it("zoomAt mantém âncora", () => {
    const s: ViewState = { scale: 0.37, panX: -12.5, panY: 40, mode: "fit" };
    const anchor = { x: 311, y: 207 };
    const before = imagePoint(s, anchor.x, anchor.y);
    const z = zoomAt(s, 2.3, anchor);
    const after = imagePoint(z, anchor.x, anchor.y);
    expect(Math.abs(after.x - before.x)).toBeLessThan(1e-6);
    expect(Math.abs(after.y - before.y)).toBeLessThan(1e-6);
    expect(z.scale).toBeCloseTo(0.851);
    expect(z.mode).toBe("free");
  });

  it("zoomAt respeita os limites de ZOOM_STEPS", () => {
    const s: ViewState = { scale: 30, panX: 0, panY: 0, mode: "free" };
    expect(zoomAt(s, 10, { x: 0, y: 0 }).scale).toBe(32);
    expect(zoomAt({ ...s, scale: 0.06 }, 0.1, { x: 0, y: 0 }).scale).toBe(0.05);
  });

  it("nextStep anda pelos degraus e para nas pontas", () => {
    expect(nextStep(1, +1)).toBe(1.25);
    expect(nextStep(32, +1)).toBe(32);
    expect(nextStep(1, -1)).toBe(0.75);
    expect(nextStep(0.05, -1)).toBe(0.05);
    expect(nextStep(0.2, +1)).toBe(0.25);
    expect(nextStep(0.2, -1)).toBe(0.1);
    expect(ZOOM_STEPS[0]).toBe(0.05);
  });

  it("clampPan centraliza imagem menor que a view", () => {
    const s = clampPan({ scale: 1, panX: -500, panY: 900, mode: "free" }, { w: 200, h: 100 }, { w: 800, h: 600 });
    expect(s.panX).toBe(300);
    expect(s.panY).toBe(250);
  });

  it("clampPan não deixa a imagem maior sair da view", () => {
    const img = { w: 2000, h: 1000 };
    const view = { w: 800, h: 600 };
    expect(clampPan({ scale: 1, panX: 50, panY: 10, mode: "free" }, img, view)).toMatchObject({ panX: 0, panY: 0 });
    expect(clampPan({ scale: 1, panX: -5000, panY: -5000, mode: "free" }, img, view)).toMatchObject({
      panX: -1200,
      panY: -400,
    });
  });

  it("fitState centraliza no modo fit e actual usa escala 1", () => {
    expect(fitState({ w: 4000, h: 3000 }, { w: 800, h: 700 }, "fit")).toEqual({ scale: 0.2, panX: 0, panY: 50, mode: "fit" });
    expect(fitState({ w: 200, h: 100 }, { w: 800, h: 600 }, "actual")).toEqual({
      scale: 1,
      panX: 300,
      panY: 250,
      mode: "actual",
    });
  });

  it("visibleRegion devolve só a parte da imagem dentro da view", () => {
    const s: ViewState = { scale: 2, panX: -100, panY: -50, mode: "free" };
    expect(visibleRegion(s, { w: 1000, h: 1000 }, { w: 400, h: 300 })).toEqual({ x: 50, y: 25, w: 200, h: 150 });
    // imagem inteira visível
    expect(visibleRegion({ scale: 0.5, panX: 0, panY: 0, mode: "fit" }, { w: 100, h: 80 }, { w: 400, h: 300 })).toEqual({
      x: 0,
      y: 0,
      w: 100,
      h: 80,
    });
  });
});
