// Arrastar na imagem seleciona um retângulo (padrão do Pré-Visualização) ou a move (preferência).
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo } from "../ipc/types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) => (cmd === "render_view" ? new Uint8Array([1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 255]).buffer : undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));

import "../select/register";
import "../markup/register";
import { registerSlot } from "../lib/slots";
import { addAnnotation } from "../markup/actions";
import { DEFAULT_STYLE } from "../markup/model";
import { getItems, getSelected, resetMarkupForTests, useMarkup } from "../markup/store";
import { resetDocsForTests, useDocs } from "../store/docs";
import { resetPrefsForTests, setPrefs } from "../store/prefs";
import { useSelection } from "../store/selection";
import { resetUiForTests, useUi } from "../store/ui";
import { Viewport } from "./Viewport";

const doc: DocInfo = {
  id: 1, path: "/p/ação.png", name: "ação.png", format: "png", width: 4000, height: 3000, frames: 1,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 0, error: null,
};

beforeAll(() => {
  class RO {
    constructor(private cb: ResizeObserverCallback) {}
    observe(el: Element) {
      Object.defineProperty(el, "clientWidth", { configurable: true, value: 800 });
      Object.defineProperty(el, "clientHeight", { configurable: true, value: 600 });
      this.cb([{ target: el, contentRect: { width: 800, height: 600 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", RO);
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement["getContext"];
  Element.prototype.setPointerCapture = () => {};
});

const vp = () => screen.getByTestId("viewport");
const pan = () => {
  const { panX, panY } = useUi.getState().view!;
  return [panX + 200, panY + 200];
};
/** Retângulo selecionado, em px da tela (a imagem está deslocada -200, -200). */
const rect = (x: number, y: number, w: number, h: number) => ({ type: "rect", data: { x: x + 200, y: y + 200, w, h } });
const selection = () => useSelection.getState().selection;
const drag = (el: Element, a: [number, number], b: [number, number], init: { button?: number } = {}) => {
  fireEvent.pointerDown(el, { button: 0, clientX: a[0], clientY: a[1], pointerId: 1, ...init });
  fireEvent.pointerMove(el, { clientX: b[0], clientY: b[1], pointerId: 1 });
  fireEvent.pointerUp(el, { clientX: b[0], clientY: b[1], pointerId: 1 });
};

beforeEach(() => {
  resetDocsForTests();
  resetPrefsForTests();
  setPrefs({ language: "pt-BR" });
  resetUiForTests();
  resetMarkupForTests();
  useSelection.setState({ selection: null, selectionTool: null });
  useDocs.getState().add([doc]);
  render(<Viewport />);
  act(() => useUi.getState().setView({ scale: 1, panX: -200, panY: -200, mode: "actual" }));
});
afterEach(cleanup);

describe("arrastar na imagem", () => {
  it("por padrão seleciona um retângulo e não move a imagem", () => {
    drag(vp(), [20, 30], [120, 90]);
    expect(selection()).toEqual(rect(20, 30, 100, 60));
    expect(pan()).toEqual([0, 0]);
    expect(useSelection.getState().selectionTool).toBeNull();
    expect(vp().classList.contains("drag-selects")).toBe(true);
  });

  it("com a preferência, arrastar move a imagem e não seleciona", () => {
    act(() => setPrefs({ dragPans: true }));
    drag(vp(), [20, 30], [120, 90]);
    expect(selection()).toBeNull();
    expect(pan()).toEqual([100, 60]);
    expect(vp().classList.contains("drag-selects")).toBe(false);
  });

  it("botão do meio e Espaço+arrastar sempre movem", () => {
    drag(vp(), [20, 30], [30, 30], { button: 1 });
    expect(pan()).toEqual([10, 0]);
    fireEvent.keyDown(window, { key: " ", code: "Space" });
    drag(vp(), [20, 30], [40, 30]);
    fireEvent.keyUp(window, { key: " ", code: "Space" });
    expect(pan()).toEqual([30, 0]);
    expect(selection()).toBeNull();
  });

  it("um clique com leve tremida não seleciona; fora da seleção, desmarca; dentro, mantém", () => {
    drag(vp(), [20, 30], [21, 31]);
    expect(selection()).toBeNull();
    drag(vp(), [20, 30], [120, 90]);
    drag(vp(), [60, 60], [60, 60]);
    expect(selection()).not.toBeNull();
    drag(vp(), [200, 200], [201, 200]);
    expect(selection()).toBeNull();
  });

  it("arrastar dentro move a seleção e as alças a redimensionam", () => {
    drag(vp(), [20, 30], [120, 90]);
    drag(vp(), [60, 60], [70, 65]);
    expect(selection()).toEqual(rect(30, 35, 100, 60));
    drag(vp(), [130, 95], [150, 95]);
    expect(selection()).toEqual(rect(30, 35, 120, 60));
  });

  it("duplo clique continua alternando o zoom", () => {
    const before = useUi.getState().view!.mode;
    fireEvent.doubleClick(vp(), { clientX: 50, clientY: 50 });
    expect(useUi.getState().view!.mode).not.toBe(before);
  });

  it("o cancelamento do ponteiro descarta o arrasto", () => {
    fireEvent.pointerDown(vp(), { button: 0, clientX: 20, clientY: 30, pointerId: 1 });
    fireEvent.pointerMove(vp(), { clientX: 120, clientY: 90, pointerId: 1 });
    fireEvent.pointerCancel(vp(), { pointerId: 1 });
    expect(selection()).toBeNull();
  });

  it("a apresentação não seleciona", () => {
    act(() => useUi.setState({ slideshow: true }));
    drag(vp(), [20, 30], [120, 90]);
    expect(selection()).toBeNull();
  });

  it("quem consome o ponteiro (texto da imagem) tem prioridade", () => {
    const Word = () => <div ref={(el) => el?.addEventListener("pointerdown", (e) => e.stopPropagation())} data-testid="palavra" />;
    let off = () => {};
    act(() => void (off = registerSlot("viewport-overlay", "palavra", Word)));
    drag(screen.getByTestId("palavra"), [20, 30], [120, 90]);
    act(off);
    expect(selection()).toBeNull();
  });

  it("botões sobre a imagem (Texto ao Vivo) não iniciam seleção", () => {
    const Button = () => <button type="button">Texto ao Vivo</button>;
    let off = () => {};
    act(() => void (off = registerSlot("viewport-overlay", "botao", Button)));
    drag(screen.getByRole("button", { name: "Texto ao Vivo" }), [20, 30], [120, 90]);
    act(off);
    expect(selection()).toBeNull();
  });
});

describe("com a barra de Marcação", () => {
  const layer = () => screen.getByTestId("markup-layer");
  beforeEach(() => {
    addAnnotation(1, { id: "a", kind: "rect", geom: { x: 210, y: 210, w: 50, h: 50 }, style: { ...DEFAULT_STYLE } });
    act(() => useMarkup.getState().setVisible(true));
  });

  it("a área vazia seleciona e larga a anotação; em cima dela, move a anotação", () => {
    drag(layer(), [200, 100], [260, 140]);
    expect(selection()).toEqual(rect(200, 100, 60, 40));
    expect(getSelected(1)).toEqual([]);
    drag(layer(), [30, 30], [40, 30]);
    expect(getItems(1)[0].geom).toMatchObject({ x: 220, y: 210 });
    expect(selection()).toEqual(rect(200, 100, 60, 40));
  });

  it("uma ferramenta de desenho continua desenhando", () => {
    act(() => useMarkup.getState().setTool("oval"));
    drag(layer(), [200, 100], [260, 140]);
    expect(selection()).toBeNull();
    expect(getItems(1)).toHaveLength(2);
  });
});
