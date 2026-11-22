import { describe, expect, it } from "vitest";
import { formatUnit, fromPx, maskBounds, toPx, withField } from "./crop";

describe("unidades do Recorte", () => {
  it("converte com a resolução do arquivo e usa 72 ppp sem ela", () => {
    expect(toPx(1, "in", 300)).toBe(300);
    expect(fromPx(300, "in", 300)).toBe(1);
    expect(toPx(2.54, "cm", 300)).toBeCloseTo(300);
    expect(toPx(25.4, "mm", 300)).toBeCloseTo(300);
    expect(toPx(72, "pt", 300)).toBeCloseTo(300);
    expect(toPx(1, "in", null)).toBe(72);
    expect(toPx(1, "in", 0)).toBe(72);
    expect(toPx(1, "in", NaN)).toBe(72);
    expect(toPx(5, "px", 300)).toBe(5);
  });

  it("formata inteiro em px e duas casas nas outras unidades", () => {
    expect(formatUnit(10.4, "px", 72)).toBe("10");
    expect(formatUnit(100, "cm", 254)).toBe("1");
    expect(formatUnit(100, "in", 300)).toBe("0.33");
  });
});

describe("caixa da seleção", () => {
  it("retângulo e elipse devolvem o próprio retângulo", () => {
    const r = { x: 1, y: 2, w: 3, h: 4 };
    expect(maskBounds({ type: "rect", data: r })).toEqual(r);
    expect(maskBounds({ type: "ellipse", data: r })).toEqual(r);
  });

  it("polígono: caixa dos vértices; vazio ou inválido: null", () => {
    expect(maskBounds({ type: "polygon", data: [[1, 1], [5, 2], [3, 9]] })).toEqual({ x: 1, y: 1, w: 4, h: 8 });
    expect(maskBounds({ type: "polygon", data: [] })).toBeNull();
    expect(maskBounds({ type: "polygon", data: [[NaN, 1]] })).toBeNull();
  });

  it("bitmap: caixa dos pixels dentro (corridas fora/dentro), mesmo com corrida de várias linhas", () => {
    // 4x3: fora 5, dentro 2 (x1..2 da linha 1), fora 5
    expect(maskBounds({ type: "bitmap", data: { w: 4, h: 3, rle: [5, 2, 5] } })).toEqual({ x: 1, y: 1, w: 2, h: 1 });
    // dentro de (3,0) até (1,2): cobre as três linhas inteiras no eixo x
    expect(maskBounds({ type: "bitmap", data: { w: 4, h: 3, rle: [3, 7, 2] } })).toEqual({ x: 0, y: 0, w: 4, h: 3 });
    expect(maskBounds({ type: "bitmap", data: { w: 4, h: 3, rle: [12] } })).toBeNull();
  });

  it("bitmap forjado (corridas gigantes, tamanho zero) não trava nem estoura", () => {
    expect(maskBounds({ type: "bitmap", data: { w: 0, h: 0, rle: [1, 1] } })).toBeNull();
    expect(maskBounds({ type: "bitmap", data: { w: 4, h: 3, rle: [0, 1e12, 5] } })).toEqual({ x: 0, y: 0, w: 4, h: 3 });
    expect(maskBounds({ type: "bitmap", data: { w: 4, h: 3, rle: [NaN, -3, 2] } })).toBeNull();
  });
});

describe("edição do retângulo", () => {
  const r = { x: 10, y: 10, w: 20, h: 20 };

  it("mantém dentro da imagem e com pelo menos 1 px", () => {
    expect(withField(r, "x", 90, 100, 100)).toEqual({ x: 90, y: 10, w: 10, h: 20 });
    expect(withField(r, "w", 500, 100, 100)).toEqual({ x: 10, y: 10, w: 90, h: 20 });
    expect(withField(r, "h", 0, 100, 100)).toEqual({ x: 10, y: 10, w: 20, h: 1 });
    expect(withField(r, "x", -5, 100, 100).x).toBe(0);
    expect(withField(r, "y", 1e9, 100, 100)).toEqual({ x: 10, y: 99, w: 20, h: 1 });
  });

  it("ignora valor que não é número", () => {
    expect(withField(r, "x", NaN, 100, 100)).toBe(r);
  });
});
