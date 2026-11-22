// Shift e Alt ao criar e ao redimensionar anotações.
import { describe, expect, it } from "vitest";
import { DEFAULT_STYLE, type Annotation } from "../model";
import { createShape } from "./create";
import { dragHandle, type HandleId } from "./handles";

const style = { ...DEFAULT_STYLE };
const rect: Annotation = { id: "a", kind: "rect", geom: { x: 10, y: 20, w: 40, h: 20 }, style };
const line: Annotation = { id: "l", kind: "line", geom: { x1: 0, y1: 0, x2: 100, y2: 0 }, style };
const SHIFT = { shift: true, alt: false };
const ALT = { shift: false, alt: true };
const BOTH = { shift: true, alt: true };
const drag = (a: Annotation, h: HandleId, x: number, y: number, mods = SHIFT) => dragHandle(a, h, x, y, [0, 0], 1, mods).geom;

describe("Shift ao criar", () => {
  const make = (tool: Parameters<typeof createShape>[0], b: [number, number]) => createShape(tool, [10, 10], b, style, 1, true).geom;

  it("formas ficam quadradas, para qualquer lado do arrasto", () => {
    expect(make("rect", [50, 30])).toEqual({ x: 10, y: 10, w: 40, h: 40 });
    expect(make("oval", [0, -20])).toEqual({ x: -20, y: -20, w: 30, h: 30 });
    expect(make("star", [40, 110])).toMatchObject({ w: 100, h: 100 });
  });

  it("linhas e setas prendem em múltiplos de 45°", () => {
    expect(make("line", [110, 18])).toMatchObject({ x2: 110, y2: 10 });
    const diag = make("arrow", [110, 100]) as { x2: number; y2: number };
    expect(diag.x2 - 10).toBeCloseTo(diag.y2 - 10);
    const up = make("line", [12, -90]) as { x2: number; y2: number };
    expect([up.x2, up.y2]).toEqual([10, -90]);
  });

  it("sem Shift nada muda", () => {
    expect(createShape("rect", [10, 10], [50, 30], style, 1).geom).toEqual({ x: 10, y: 10, w: 40, h: 20 });
  });
});

describe("Shift ao redimensionar", () => {
  it("o canto mantém a proporção e o canto oposto", () => {
    expect(drag(rect, "se", 90, 45)).toEqual({ x: 10, y: 20, w: 80, h: 40 });
    expect(drag(rect, "nw", -30, 30)).toEqual({ x: -30, y: 0, w: 80, h: 40 });
  });

  it("a borda mantém a proporção, crescendo dos dois lados do outro eixo", () => {
    expect(drag(rect, "e", 90, 0)).toEqual({ x: 10, y: 10, w: 80, h: 40 });
  });

  it("passar do lado oposto espelha sem perder a proporção", () => {
    expect(drag(rect, "se", -70, 20)).toEqual({ x: -70, y: 20, w: 80, h: 40 });
  });

  it("a ponta da linha prende em 45° a partir da outra", () => {
    const g = drag(line, "p2", 60, 70) as { x2: number; y2: number };
    expect(g.x2).toBeCloseTo(g.y2);
  });

  it("uma caixa sem altura não vira NaN", () => {
    const flat: Annotation = { ...rect, geom: { x: 0, y: 0, w: 40, h: 0 } } as Annotation;
    expect(drag(flat, "se", 80, 10)).toEqual({ x: 0, y: 0, w: 80, h: 10 });
  });
});

describe("Alt ao redimensionar", () => {
  it("cresce a partir do centro", () => {
    expect(drag(rect, "se", 60, 50, ALT)).toEqual({ x: 0, y: 10, w: 60, h: 40 });
    expect(drag(rect, "w", 0, 99, ALT)).toEqual({ x: 0, y: 20, w: 60, h: 20 });
  });

  it("com Shift, do centro e em proporção", () => {
    expect(drag(rect, "se", 70, 31, BOTH)).toEqual({ x: -10, y: 10, w: 80, h: 40 });
  });

  it("na linha, a outra ponta espelha", () => {
    expect(drag(line, "p2", 120, 10, ALT)).toEqual({ x1: -20, y1: -10, x2: 120, y2: 10 });
  });
});
