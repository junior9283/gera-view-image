import { describe, expect, it } from "vitest";
import {
  DEFAULT_STYLE,
  bounds,
  deserialize,
  hitTest,
  moveItems,
  restyle,
  serialize,
  transformForOp,
  type Annotation,
  type AnnotationDoc,
} from "./model";

const rect = (id: string, x = 10, y = 10): Annotation => ({
  id,
  kind: "rect",
  geom: { x, y, w: 50, h: 30 },
  style: { ...DEFAULT_STYLE },
});

describe("modelo de anotações", () => {
  it("move só as selecionadas", () => {
    const items = [rect("a"), rect("b", 100, 100)];
    const out = moveItems(items, ["b"], 5, -5);
    expect(out[0]).toBe(items[0]);
    expect(out[1].geom).toMatchObject({ x: 105, y: 95 });
    expect(items[1].geom).toMatchObject({ x: 100, y: 100 }); // imutável
  });

  it("deslocamento zero devolve o mesmo array (clicar para selecionar não vira passo)", () => {
    const items = [rect("a")];
    expect(moveItems(items, ["a"], 0, 0)).toBe(items);
  });

  it("move linha, mão livre, lupa e a cauda do balão", () => {
    const items: Annotation[] = [
      { id: "l", kind: "arrow", geom: { x1: 0, y1: 0, x2: 10, y2: 10 }, style: DEFAULT_STYLE },
      { id: "f", kind: "freehand", geom: { points: [[1, 1], [2, 2]] }, style: DEFAULT_STYLE },
      { id: "z", kind: "loupe", geom: { cx: 50, cy: 50, r: 20, zoom: 2 }, style: DEFAULT_STYLE },
      { id: "b", kind: "bubble", geom: { x: 0, y: 0, w: 10, h: 10, tail: { x: 5, y: 20 } }, style: DEFAULT_STYLE },
    ];
    const out = moveItems(items, ["l", "f", "z", "b"], 1, 2);
    expect(out[0].geom).toEqual({ x1: 1, y1: 2, x2: 11, y2: 12 });
    expect(out[1].geom).toEqual({ points: [[2, 3], [3, 4]] });
    expect(out[2].geom).toMatchObject({ cx: 51, cy: 52 });
    expect(out[3].geom).toEqual({ x: 1, y: 2, w: 10, h: 10, tail: { x: 6, y: 22 } });
  });

  it("alterar estilo de várias selecionadas", () => {
    const items = [rect("a"), rect("b"), rect("c")];
    const out = restyle(items, ["a", "c"], { stroke: "#00ff00", width: 8, dash: "dashed" });
    expect(out[0].style).toMatchObject({ stroke: "#00ff00", width: 8, dash: "dashed" });
    expect(out[2].style).toMatchObject({ stroke: "#00ff00", width: 8, dash: "dashed" });
    expect(out[1].style).toEqual(DEFAULT_STYLE);
  });

  it("estilo de fonte é mesclado, não substituído", () => {
    const t: Annotation = {
      id: "t",
      kind: "text",
      geom: { x: 0, y: 0, w: 100, h: 20, text: "oi" },
      style: { ...DEFAULT_STYLE, font: { family: "Inter", size: 18, color: "#000", bold: false, italic: false, underline: false, align: "left" } },
    };
    const [out] = restyle([t], ["t"], { font: { bold: true } });
    expect(out.style.font).toMatchObject({ family: "Inter", size: 18, bold: true });
  });

  it("serializa e desserializa sem perda", () => {
    const doc: AnnotationDoc = {
      items: [
        rect("a"),
        { id: "t", kind: "text", geom: { x: 1, y: 2, w: 3, h: 4, text: "Olá\nmundo" }, style: { ...DEFAULT_STYLE, font: { family: "Inter", size: 12, color: "#123456", bold: true, italic: true, underline: true, align: "center" } } },
        { id: "s", kind: "star", geom: { x: 0, y: 0, w: 9, h: 9, points: 7 }, style: { ...DEFAULT_STYLE, fill: "#ff0", shadow: true } },
        { id: "z", kind: "loupe", geom: { cx: 5, cy: 6, r: 7, zoom: 3.5 }, style: DEFAULT_STYLE },
        { id: "h", kind: "highlight", geom: { x: 1, y: 1, w: 5, h: 5, shape: "oval" }, style: DEFAULT_STYLE },
        { id: "g", kind: "signature", geom: { x: 1, y: 1, w: 5, h: 5, src: "data:image/png;base64,AAAA" }, style: DEFAULT_STYLE },
        { id: "f", kind: "freehand", geom: { points: [[0.5, 1.25], [3, 4]] }, style: { ...DEFAULT_STYLE, dash: "dotted", arrowStart: "arrow", arrowEnd: "circle" } },
      ],
    };
    const back = deserialize(serialize(doc));
    expect(back).toEqual(doc);
  });

  it("desserializar descarta itens inválidos", () => {
    const back = deserialize(JSON.stringify({ items: [{ id: "x", kind: "nave", geom: {}, style: {} }, rect("a")] }));
    expect(back.items.map((a) => a.id)).toEqual(["a"]);
    expect(deserialize("lixo")).toEqual({ items: [] });
  });

  it("assinatura/imagem só com src PNG em data URL", () => {
    const sig = (src: string) => ({ id: src, kind: "signature", geom: { x: 0, y: 0, w: 1, h: 1, src }, style: DEFAULT_STYLE });
    const json = JSON.stringify({ items: [sig("data:image/png;base64,AAAA"), sig("https://exemplo.com/x.png"), sig("data:image/svg+xml;base64,PHN2Zz4="), sig("file:///etc/passwd")] });
    expect(deserialize(json).items.map((a) => a.id)).toEqual(["data:image/png;base64,AAAA"]);
  });

  it("hitTest acha a de cima e respeita a tolerância da linha", () => {
    const items: Annotation[] = [
      rect("baixo", 0, 0),
      rect("cima", 20, 0),
      { id: "l", kind: "line", geom: { x1: 200, y1: 0, x2: 300, y2: 0 }, style: DEFAULT_STYLE },
    ];
    expect(hitTest(items, 30, 10, 4)?.id).toBe("cima");
    expect(hitTest(items, 5, 10, 4)?.id).toBe("baixo");
    expect(hitTest(items, 250, 3, 4)?.id).toBe("l");
    expect(hitTest(items, 250, 30, 4)).toBeNull();
  });

  it("bounds normaliza caixas e cobre a lupa", () => {
    expect(bounds({ id: "z", kind: "loupe", geom: { cx: 50, cy: 40, r: 10, zoom: 2 }, style: DEFAULT_STYLE })).toEqual({ x: 40, y: 30, w: 20, h: 20 });
    expect(bounds({ id: "l", kind: "line", geom: { x1: 10, y1: 5, x2: 0, y2: 0 }, style: DEFAULT_STYLE })).toEqual({ x: 0, y: 0, w: 10, h: 5 });
  });

  describe("acompanha as Op geométricas", () => {
    const arrow: Annotation = { id: "s", kind: "arrow", geom: { x1: 10, y1: 20, x2: 30, y2: 20 }, style: DEFAULT_STYLE };
    const box: Annotation = { id: "b", kind: "rect", geom: { x: 10, y: 20, w: 40, h: 10 }, style: DEFAULT_STYLE };
    const text: Annotation = { id: "t", kind: "text", geom: { x: 10, y: 20, w: 40, h: 10, text: "x" }, style: DEFAULT_STYLE };

    it("girar à esquerda (100×50 → 50×100)", () => {
      const [a, b, t] = transformForOp([arrow, box, text], { type: "rotate", data: { quarterTurns: -1 } }, 100, 50)!;
      expect(a.geom).toEqual({ x1: 20, y1: 90, x2: 20, y2: 70 });
      expect(b.geom).toEqual({ x: 20, y: 50, w: 10, h: 40 });
      // Texto não deita: só o centro acompanha.
      expect(t.geom).toMatchObject({ x: 5, y: 65, w: 40, h: 10 });
    });

    it("girar à direita e espelhar", () => {
      expect(transformForOp([arrow], { type: "rotate", data: { quarterTurns: 1 } }, 100, 50)![0].geom).toEqual({ x1: 30, y1: 10, x2: 30, y2: 30 });
      expect(transformForOp([box], { type: "flipH" }, 100, 50)![0].geom).toEqual({ x: 50, y: 20, w: 40, h: 10 });
      expect(transformForOp([box], { type: "flipV" }, 100, 50)![0].geom).toEqual({ x: 10, y: 20, w: 40, h: 10 });
    });

    it("recortar desloca e redimensionar escala", () => {
      expect(transformForOp([box], { type: "crop", data: { x: 5, y: 10, w: 50, h: 30 } }, 100, 50)![0].geom).toEqual({ x: 5, y: 10, w: 40, h: 10 });
      const z: Annotation = { id: "z", kind: "loupe", geom: { cx: 50, cy: 25, r: 10, zoom: 2 }, style: DEFAULT_STYLE };
      const [r, l] = transformForOp([box, z], { type: "resize", data: { w: 200, h: 100, filter: "lanczos3", dpi: null } }, 100, 50)!;
      expect(r.geom).toEqual({ x: 20, y: 40, w: 80, h: 20 });
      expect(l.geom).toEqual({ cx: 100, cy: 50, r: 20, zoom: 2 });
    });

    it("redimensionar escala também a espessura e o tamanho da fonte", () => {
      const styled: Annotation = { ...text, style: { ...DEFAULT_STYLE, width: 6, font: { family: "Inter", size: 20, color: "#000", bold: false, italic: false, underline: false, align: "left" } } };
      const [a, t] = transformForOp([{ ...arrow, style: { ...DEFAULT_STYLE, width: 6 } }, styled], { type: "resize", data: { w: 50, h: 25, filter: "lanczos3", dpi: null } }, 100, 50)!;
      expect(a.style.width).toBe(3);
      expect(t.style.width).toBe(3);
      expect(t.style.font?.size).toBe(10);
      expect(t.geom).toMatchObject({ w: 20, h: 5 });
    });

    it("Op sem geometria não mexe", () => {
      expect(transformForOp([box], { type: "flipH" }, 100, 50)).not.toBeNull();
      expect(transformForOp([box], { type: "erase", data: { type: "rect", data: { x: 0, y: 0, w: 1, h: 1 } } }, 100, 50)).toBeNull();
    });
  });
});
