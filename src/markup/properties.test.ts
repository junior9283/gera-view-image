import { describe, expect, it } from "vitest";
import { DEFAULT_STYLE, withText, type Annotation } from "./model";
import { editableBox, hasEditableBox, withBox } from "./properties";

const rect = (g = { x: 10, y: 20, w: 30, h: 40 }): Annotation => ({ id: "r", kind: "rect", geom: g, style: DEFAULT_STYLE });
const text: Annotation = { id: "t", kind: "text", geom: { x: 0, y: 0, w: 50, h: 20, text: "oi" }, style: DEFAULT_STYLE };
const line: Annotation = { id: "l", kind: "line", geom: { x1: 0, y1: 0, x2: 5, y2: 5 }, style: DEFAULT_STYLE };

describe("propriedades da anotação", () => {
  it("só as formas com caixa são editáveis", () => {
    expect(hasEditableBox(rect())).toBe(true);
    expect(hasEditableBox(line)).toBe(false);
    expect(editableBox(line)).toBeNull();
    expect(editableBox(rect({ x: 40, y: 60, w: -30, h: -40 }))).toEqual({ x: 10, y: 20, w: 30, h: 40 });
  });

  it("troca posição e tamanho sem mexer no resto", () => {
    const r = withBox(rect(), { x: 5, w: 99 });
    expect(r).toMatchObject({ kind: "rect", geom: { x: 5, y: 20, w: 99, h: 40 }, style: DEFAULT_STYLE });
  });

  it("ignora valores inválidos e tamanhos nulos", () => {
    expect((withBox(rect(), { x: NaN, w: 0, h: -3, y: Infinity }) as { geom: object }).geom).toEqual({ x: 10, y: 20, w: 30, h: 40 });
    expect(withBox(line, { x: 3 })).toBe(line);
  });

  it("normaliza caixas invertidas ao editar", () => {
    expect((withBox(rect({ x: 40, y: 60, w: -30, h: -40 }), { w: 8 }) as { geom: object }).geom).toEqual({ x: 10, y: 20, w: 8, h: 40 });
  });

  it("só texto e as formas aceitam novo conteúdo", () => {
    expect(withText(text, "novo")).toMatchObject({ geom: { text: "novo", w: 50 } });
    expect(withText(rect(), "x")).toMatchObject({ text: "x", geom: rect().geom });
    expect(withText(line, "x")).toBe(line);
  });
});
