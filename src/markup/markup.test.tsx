import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo } from "../ipc/types";

vi.mock("../ipc/commands", () => ({
  applyOp: vi.fn(),
  undo: vi.fn(),
  redo: vi.fn(),
  renderView: vi.fn(async () => ({ width: 1, height: 1, data: new Uint8ClampedArray(4) })),
  instantAlpha: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn(async () => { throw new Error("sem store"); }) }));

import { Slot } from "../lib/slots";
import { useDocs, resetDocsForTests } from "../store/docs";
import { getAnnotationSource } from "../inspector/annotations";
import "./register";
import { DEFAULT_STYLE, type Annotation } from "./model";
import { getItems, resetMarkupForTests, useMarkup } from "./store";
import { addAnnotation } from "./actions";
import { resetHistoryForTests } from "./history";

const info: DocInfo = {
  id: 7, path: "/a.png", name: "a.png", format: "png", width: 400, height: 300, frames: 1,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 1, error: null,
};
const overlay = { scale: 1, panX: 0, panY: 0, imageW: 400, imageH: 300 };
const rect = (id: string): Annotation => ({ id, kind: "rect", geom: { x: 10, y: 10, w: 50, h: 50 }, style: { ...DEFAULT_STYLE } });

beforeAll(() => {
  // jsdom não tem canvas 2D; a camada só precisa não quebrar.
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;
});
beforeEach(() => {
  resetDocsForTests();
  useDocs.getState().add([info]);
  resetMarkupForTests();
  resetHistoryForTests();
});
afterEach(cleanup);

const toggle = () => act(() => void window.dispatchEvent(new Event("gvi:toggle-markup")));

describe("barra de Marcação", () => {
  it("gvi:toggle-markup mostra e oculta a barra", () => {
    render(<Slot name="below-toolbar" props={{}} />);
    expect(screen.queryByRole("toolbar")).toBeNull();
    toggle();
    expect(screen.getByRole("toolbar", { name: "Barra de Marcação" })).toBeTruthy();
    toggle();
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("ferramentas na ordem do Preview", () => {
    render(<Slot name="below-toolbar" props={{}} />);
    toggle();
    const labels = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual([
      "Seleção", "Esboço", "Desenho", "Formas", "Texto", "Assinatura", "Estilo da linha",
      "Cor da borda", "Cor de preenchimento", "Estilo do texto", "Girar para a esquerda", "Recortar",
    ]);
  });

  it("escolher uma forma no menu ativa a ferramenta", () => {
    render(<Slot name="below-toolbar" props={{}} />);
    toggle();
    fireEvent.click(screen.getByRole("button", { name: "Formas" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Seta" }));
    expect(useMarkup.getState().tool).toBe("arrow");
  });
});

describe("camada de anotações", () => {
  it("só recebe o ponteiro com a marcação ativa", () => {
    render(<Slot name="viewport-overlay" props={overlay} />);
    const layer = screen.getByTestId("markup-layer");
    expect(layer.style.pointerEvents).toBe("none");
    toggle();
    expect(layer.style.pointerEvents).toBe("auto");
  });

  it("arrastar com a ferramenta Seta cria a seta (convertida pela escala)", () => {
    render(<Slot name="viewport-overlay" props={{ ...overlay, scale: 2, panX: 10, panY: 20 }} />);
    toggle();
    act(() => useMarkup.getState().setTool("arrow"));
    const layer = screen.getByTestId("markup-layer");
    fireEvent.pointerDown(layer, { button: 0, clientX: 30, clientY: 40, pointerId: 1 });
    fireEvent.pointerMove(layer, { clientX: 130, clientY: 40, pointerId: 1 });
    fireEvent.pointerUp(layer, { clientX: 130, clientY: 40, pointerId: 1 });
    const [a] = getItems(7);
    expect(a.kind).toBe("arrow");
    expect(a.geom).toEqual({ x1: 10, y1: 10, x2: 60, y2: 10 });
    expect(a.style.arrowEnd).toBe("arrow");
    expect(useMarkup.getState().tool).toBe("select");
    expect(useMarkup.getState().selected[7]).toEqual([a.id]);
  });

  it("pointerdown com a marcação ativa não chega ao Viewport (pan)", () => {
    const pan = vi.fn();
    render(
      <div ref={(el) => el?.addEventListener("pointerdown", pan)}>
        <Slot name="viewport-overlay" props={overlay} />
      </div>,
    );
    toggle();
    act(() => useMarkup.getState().setTool("rect"));
    fireEvent.pointerDown(screen.getByTestId("markup-layer"), { button: 0, clientX: 5, clientY: 5, pointerId: 1 });
    expect(pan).not.toHaveBeenCalled();
  });

  it("Delete apaga as selecionadas só com a marcação ativa e fora de campos de texto", () => {
    render(
      <>
        <input data-testid="campo" />
        <Slot name="viewport-overlay" props={overlay} />
      </>,
    );
    act(() => {
      addAnnotation(7, rect("a"));
      useMarkup.getState().select(7, ["a"]);
    });
    fireEvent.keyDown(window, { key: "Delete" });
    expect(getItems(7)).toHaveLength(1); // marcação inativa

    toggle();
    fireEvent.keyDown(screen.getByTestId("campo"), { key: "Delete" });
    expect(getItems(7)).toHaveLength(1); // foco num input

    const outro = vi.fn();
    window.addEventListener("keydown", outro);
    fireEvent.keyDown(document.body, { key: "Delete" });
    window.removeEventListener("keydown", outro);
    expect(getItems(7)).toHaveLength(0);
    expect(outro).not.toHaveBeenCalled(); // o Apagar da seleção (Task 6) não roda junto
  });
});

describe("inspetor", () => {
  it("lista as anotações do documento e seleciona pela lista", () => {
    act(() => {
      addAnnotation(7, rect("a"));
      addAnnotation(7, { id: "t", kind: "text", geom: { x: 0, y: 0, w: 10, h: 10, text: "Olá" }, style: DEFAULT_STYLE });
    });
    const src = getAnnotationSource()!;
    expect(src.list(7)).toEqual([
      { id: "a", kind: "rect", label: "Retângulo" },
      { id: "t", kind: "text", label: "Olá" },
    ]);
    src.select(7, "t");
    expect(useMarkup.getState().selected[7]).toEqual(["t"]);
    expect(useMarkup.getState().visible).toBe(true);
  });
});
