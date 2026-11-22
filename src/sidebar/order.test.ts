import { describe, expect, it } from "vitest";
import { dropIndex, gridIndex, marqueeHits, moveIds, type Box } from "./order";

/** Grade de `n` itens de 100×100, com `cols` colunas e 10 px de intervalo. */
const grid = (n: number, cols: number): Box[] =>
  Array.from({ length: n }, (_, i) => {
    const left = (i % cols) * 110;
    const top = Math.floor(i / cols) * 110;
    return { left, top, right: left + 100, bottom: top + 100 };
  });

describe("gridIndex", () => {
  const at = (key: string, i: number) => gridIndex(key, i, 8, 3, 2);
  it("setas andam na grade e param nas bordas", () => {
    expect(at("ArrowRight", 2)).toBe(3);
    expect(at("ArrowLeft", 3)).toBe(2);
    expect(at("ArrowDown", 1)).toBe(4);
    expect(at("ArrowUp", 4)).toBe(1);
    expect(at("ArrowLeft", 0)).toBe(0);
    expect(at("ArrowRight", 7)).toBe(7);
    expect(at("ArrowUp", 1)).toBe(1);
    expect(at("ArrowDown", 6)).toBe(6);
  });
  it("para baixo, sem item logo abaixo mas com outra linha, vai ao último", () => {
    expect(at("ArrowDown", 5)).toBe(7);
  });
  it("Home, End e páginas", () => {
    expect(at("Home", 5)).toBe(0);
    expect(at("End", 1)).toBe(7);
    expect(at("PageDown", 0)).toBe(6);
    expect(at("PageDown", 4)).toBe(7);
    expect(at("PageUp", 7)).toBe(1);
  });
  it("outras teclas e lista vazia: nada", () => {
    expect(at("x", 1)).toBeNull();
    expect(gridIndex("ArrowDown", 0, 0, 1, 1)).toBeNull();
  });
});

describe("dropIndex", () => {
  it("em lista, vale a metade da altura", () => {
    const list = grid(3, 1);
    expect(dropIndex(list, { x: 50, y: 20 }, "list")).toBe(0);
    expect(dropIndex(list, { x: 50, y: 80 }, "list")).toBe(1);
    expect(dropIndex(list, { x: 50, y: 900 }, "list")).toBe(3);
    expect(dropIndex([], { x: 0, y: 0 }, "list")).toBe(0);
  });
  it("em grade, vale a metade da largura na linha do ponteiro", () => {
    const g = grid(5, 3);
    expect(dropIndex(g, { x: 20, y: 50 }, "grid")).toBe(0);
    expect(dropIndex(g, { x: 80, y: 50 }, "grid")).toBe(1);
    expect(dropIndex(g, { x: 320, y: 50 }, "grid")).toBe(3);
    expect(dropIndex(g, { x: 80, y: 160 }, "grid")).toBe(4);
    // À direita do último e abaixo de tudo: no fim.
    expect(dropIndex(g, { x: 300, y: 160 }, "grid")).toBe(5);
    expect(dropIndex(g, { x: 10, y: 900 }, "grid")).toBe(5);
  });
});

describe("moveIds", () => {
  it("leva um item para antes da posição pedida", () => {
    expect(moveIds([1, 2, 3, 4], [1], 3)).toEqual([2, 3, 1, 4]);
    expect(moveIds([1, 2, 3, 4], [4], 0)).toEqual([4, 1, 2, 3]);
    expect(moveIds([1, 2, 3, 4], [2], 4)).toEqual([1, 3, 4, 2]);
  });
  it("leva vários juntos, na ordem dada, mesmo com a posição no meio deles", () => {
    expect(moveIds([1, 2, 3, 4, 5], [1, 5], 3)).toEqual([2, 3, 1, 5, 4]);
    expect(moveIds([1, 2, 3, 4], [2, 3], 2)).toEqual([1, 2, 3, 4]);
  });
  it("ignora ids desconhecidos", () => {
    expect(moveIds([1, 2], [9], 0)).toEqual([1, 2]);
  });
});

describe("marqueeHits", () => {
  it("pega os itens que o retângulo toca, em qualquer sentido do arraste", () => {
    const g = grid(5, 3);
    expect(marqueeHits(g, { x: 90, y: 50 }, { x: 120, y: 60 })).toEqual([0, 1]);
    expect(marqueeHits(g, { x: 120, y: 150 }, { x: 90, y: 50 })).toEqual([0, 1, 3, 4]);
    expect(marqueeHits(g, { x: 103, y: 0 }, { x: 107, y: 300 })).toEqual([]);
  });
});
