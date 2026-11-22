// Texto dentro de formas e balões: edição por duplo clique, desenho, achatamento e inspetor.
import { act, cleanup, fireEvent, render as mount, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo } from "../ipc/types";

vi.mock("../ipc/commands", () => ({ applyOp: vi.fn(), undo: vi.fn(), redo: vi.fn(), renderView: vi.fn(), instantAlpha: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn(async () => { throw new Error("sem store"); }) }));

import { undo, redo } from "../edit/history";
import { getAnnotationSource } from "../inspector/annotations";
import { Slot } from "../lib/slots";
import { resetDocsForTests, useDocs } from "../store/docs";
import { useSelection } from "../store/selection";
import "./register";
import { addAnnotation } from "./actions";
import { resetHistoryForTests } from "./history";
import { DEFAULT_FONT, DEFAULT_STYLE, deserialize, serialize, textBox, transformForOp, type Annotation, type Kind } from "./model";
import { flattenToPng, render } from "./render";
import { getItems, getSelected, resetMarkupForTests, useMarkup } from "./store";
import { wrapText } from "./textLayout";

const info: DocInfo = {
  id: 7, path: "/a.png", name: "a.png", format: "png", width: 400, height: 300, frames: 1,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 1, error: null,
};
const overlay = { scale: 1, panX: 0, panY: 0, imageW: 400, imageH: 300 };
const style = { ...DEFAULT_STYLE, font: { ...DEFAULT_FONT, size: 10 } };
const box = { x: 10, y: 10, w: 200, h: 100 };
const SHAPES: Record<string, Annotation> = {
  rect: { id: "s", kind: "rect", geom: box, style },
  roundRect: { id: "s", kind: "roundRect", geom: { ...box, radius: 20 }, style },
  oval: { id: "s", kind: "oval", geom: box, style },
  bubble: { id: "s", kind: "bubble", geom: { ...box, tail: { x: 60, y: 160 } }, style },
  star: { id: "s", kind: "star", geom: { ...box, points: 5 }, style },
  polygon: { id: "s", kind: "polygon", geom: { ...box, sides: 6 }, style },
};

type Call = [string, ...unknown[]];
function mockCtx() {
  const calls: Call[] = [];
  const target: Record<string | symbol, unknown> = { calls, canvas: {} };
  return new Proxy(target, {
    get(t, p) {
      if (p in t) return t[p];
      return (t[p] = (...args: unknown[]) => {
        calls.push([String(p), ...args]);
        return p === "measureText" ? { width: String(args[0]).length * 5 } : undefined;
      });
    },
  }) as unknown as CanvasRenderingContext2D & { calls: Call[] };
}
const texts = (ctx: { calls: Call[] }) => ctx.calls.filter((c) => c[0] === "fillText");

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;
});
beforeEach(() => {
  resetDocsForTests();
  useDocs.getState().add([info]);
  resetMarkupForTests();
  resetHistoryForTests();
  useSelection.setState({ selection: null, selectionTool: null });
  useMarkup.setState({ visible: true });
});
afterEach(cleanup);

const layer = () => screen.getByTestId("markup-layer");
const open = (a: Annotation) => {
  act(() => addAnnotation(7, a, false));
  mount(<Slot name="viewport-overlay" props={overlay} />);
  fireEvent.doubleClick(layer(), { clientX: 110, clientY: 60 });
};
const type = (value: string) => {
  const el = screen.getByRole("textbox");
  fireEvent.change(el, { target: { value } });
  fireEvent.blur(el);
};
const shape = () => getItems(7)[0];

describe("duplo clique", () => {
  it.each(Object.keys(SHAPES))("edita o texto dentro de %s", (kind) => {
    open(SHAPES[kind]);
    expect(getSelected(7)).toEqual(["s"]);
    type("Olá, você\nnão ");
    expect(shape()).toMatchObject({ kind, geom: SHAPES[kind].geom, text: "Olá, você\nnão" });
    expect(shape().style.font?.align).toBe("center"); // começa centralizado, como no Pré-Visualização
  });

  it.each(["line", "loupe", "highlight"] as Kind[])("%s não leva texto", (kind) => {
    const geom = kind === "line" ? { x1: 10, y1: 60, x2: 210, y2: 60 } : kind === "loupe" ? { cx: 110, cy: 60, r: 40, zoom: 2 } : { ...box, shape: "rect" };
    open({ id: "s", kind, geom, style } as Annotation);
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("editar de novo parte do texto que já estava e mantém o alinhamento escolhido", () => {
    open({ ...SHAPES.bubble, text: "Primeira", style: { ...style, font: { ...style.font, align: "right" } } });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Primeira");
    type("Segunda");
    expect(shape()).toMatchObject({ text: "Segunda" });
    expect(shape().style.font?.align).toBe("right");
  });

  it("apagar o texto mantém a forma; sem mudança não há passo", () => {
    open({ ...SHAPES.rect, text: "x" });
    const before = getItems(7);
    fireEvent.blur(screen.getByRole("textbox"));
    expect(getItems(7)).toBe(before);
    fireEvent.doubleClick(layer(), { clientX: 110, clientY: 60 });
    type("");
    expect(shape().kind).toBe("rect");
    expect(shape().text).toBeUndefined();
  });

  it("cada edição é um passo de desfazer e refazer", async () => {
    open(SHAPES.oval);
    type("Ação");
    await act(async () => void (await undo(7)));
    expect(shape().text).toBeUndefined();
    await act(async () => void (await redo(7)));
    expect(shape().text).toBe("Ação");
  });

  it("Enter edita a forma selecionada, sem mouse", () => {
    act(() => addAnnotation(7, SHAPES.rect));
    mount(<Slot name="viewport-overlay" props={overlay} />);
    act(() => void document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(screen.getByRole("textbox")).toBeTruthy();
  });
});

describe("desenho", () => {
  const draw = (a: Annotation, skip?: string) => {
    const ctx = mockCtx();
    render(ctx, [a], { scale: 1, panX: 0, panY: 0 }, null, { imageW: 400, imageH: 300, skip });
    return ctx;
  };

  it.each(Object.keys(SHAPES))("quebra as linhas e centraliza na vertical dentro de %s", (kind) => {
    const a = { ...SHAPES[kind], text: "muitas palavras acentuadas que não cabem numa linha só", style: { ...style, font: { ...style.font, align: "center" as const } } };
    const lines = texts(draw(a));
    expect(lines.length).toBeGreaterThan(1);
    const b = textBox(a)!;
    const ys = lines.map((l) => l[3] as number);
    expect((ys[0] + ys[ys.length - 1] + 12.5) / 2).toBeCloseTo(b.y + b.h / 2);
    for (const l of lines) {
      expect(l[2]).toBeCloseTo(b.x + b.w / 2);
      expect(String(l[1]).length * 5).toBeLessThanOrEqual(b.w);
    }
  });

  it("em edição, a forma continua desenhada e só o texto some", () => {
    const ctx = draw({ ...SHAPES.rect, text: "x" }, "s");
    expect(texts(ctx)).toEqual([]);
    expect(ctx.calls.some((c) => c[0] === "stroke")).toBe(true);
  });

  it("o texto não leva a sombra da forma", () => {
    const ctx = draw({ ...SHAPES.rect, text: "x", style: { ...style, shadow: true } });
    expect((ctx as unknown as { shadowColor: string }).shadowColor).toBe("transparent");
  });

  it("sai no achatamento (salvar, exportar, imprimir)", async () => {
    let ctx: ReturnType<typeof mockCtx> | null = null;
    vi.stubGlobal("OffscreenCanvas", class {
      getContext() {
        return (ctx = mockCtx());
      }
      async convertToBlob() {
        return new Blob(["x"]);
      }
    });
    await flattenToPng([{ ...SHAPES.bubble, text: "Olá!" }], 400, 300, null);
    vi.unstubAllGlobals();
    expect(texts(ctx!).map((c) => c[1])).toEqual(["Olá!"]);
  });

  it("a caixa do texto fica dentro da forma e nunca é negativa", () => {
    for (const a of Object.values(SHAPES)) {
      const b = textBox(a)!;
      expect([b.x >= 10, b.y >= 10, b.x + b.w <= 210, b.y + b.h <= 110]).toEqual([true, true, true, true]);
      const tiny = textBox({ ...a, geom: { ...a.geom, w: 1, h: 1 } } as Annotation)!;
      expect(Math.min(tiny.w, tiny.h)).toBeGreaterThanOrEqual(0);
    }
    expect(textBox({ id: "l", kind: "line", geom: { x1: 0, y1: 0, x2: 1, y2: 1 }, style })).toBeNull();
  });
});

describe("quebra de linha", () => {
  const measure = (s: string) => [...s].length;
  it("quebra nas palavras, respeita as quebras digitadas e parte a palavra que não cabe", () => {
    expect(wrapText("um dois três", 8, measure)).toEqual(["um dois", "três"]);
    expect(wrapText("a\n\nb", 8, measure)).toEqual(["a", "", "b"]);
    expect(wrapText("inconstitucional", 6, measure)).toEqual(["incons", "tituci", "onal"]);
    expect(wrapText("ok coração", 4, measure)).toEqual(["ok", "cora", "ção"]);
  });

  it("largura zero não entra em laço infinito", () => {
    expect(wrapText("abc", 0, measure)).toEqual(["a", "b", "c"]);
    expect(wrapText("👍🏽é", 0, measure).join("")).toBe("👍🏽é");
  });
});

describe("modelo", () => {
  it("o texto acompanha girar e redimensionar a imagem, e a serialização o valida", () => {
    const a = { ...SHAPES.rect, text: "Ação" };
    expect(transformForOp([a], { type: "rotate", data: { quarterTurns: 1 } }, 400, 300)![0].text).toBe("Ação");
    const [r] = transformForOp([a], { type: "resize", data: { w: 800, h: 600 } } as never, 400, 300)!;
    expect([r.text, r.style.font?.size]).toEqual(["Ação", 20]);
    expect(deserialize(serialize({ items: [a] })).items).toEqual([a]);
    expect(deserialize(JSON.stringify({ items: [{ ...a, text: 5 }] })).items).toEqual([]);
  });

  it("a lista do Inspetor mostra o texto, e o Inspetor de Marcação o edita", () => {
    act(() => addAnnotation(7, { ...SHAPES.bubble, text: "Olá\nmundo" }));
    expect(getAnnotationSource()!.list(7)[0].label).toBe("Olá");
    mount(<Slot name="below-toolbar" props={{}} />);
    act(() => useMarkup.getState().setMenu("properties"));
    const field = screen.getByRole("textbox");
    expect((field as HTMLTextAreaElement).value).toBe("Olá\nmundo");
    fireEvent.change(field, { target: { value: "Tchau" } });
    fireEvent.blur(field);
    expect(shape().text).toBe("Tchau");
  });
});
