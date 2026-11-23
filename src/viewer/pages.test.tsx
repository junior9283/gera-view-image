// TIFF de páginas de tamanhos diferentes no visor de verdade: a seleção arrastável e a prévia ao
// vivo do Ajustar Cor usam o tamanho da página exibida (a 2, maior que a primeira).
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo } from "../ipc/types";

const invoke = vi.hoisted(() => vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));

import "../adjust/register";
import { showPreview } from "../adjust/preview";
import "../select/register";
import { resetDocsForTests, useDocs } from "../store/docs";
import { resetPrefsForTests, setPrefs } from "../store/prefs";
import { useSelection } from "../store/selection";
import { resetUiForTests, useUi } from "../store/ui";
import { Viewport } from "./Viewport";

const tiff: DocInfo = {
  id: 1, path: "/p/ação.tiff", name: "ação.tiff", format: "tiff", width: 40, height: 30, frames: 2,
  pageSizes: [[40, 30], [600, 800]],
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 0, error: null,
};
/** Buffer de 1x1 do IPC (`u32 w`, `u32 h`, RGBA). */
const pixel = () => new Uint8Array([1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 255]).buffer;

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
const selection = () => useSelection.getState().selection;
const drag = (el: Element, a: [number, number], b: [number, number]) => {
  fireEvent.pointerDown(el, { button: 0, clientX: a[0], clientY: a[1], pointerId: 1 });
  fireEvent.pointerMove(el, { clientX: b[0], clientY: b[1], pointerId: 1 });
  fireEvent.pointerUp(el, { clientX: b[0], clientY: b[1], pointerId: 1 });
};

beforeEach(() => {
  invoke.mockReset().mockImplementation(async (cmd) => (cmd === "render_screen" || cmd === "preview_adjust" ? pixel() : undefined));
  resetDocsForTests();
  resetPrefsForTests();
  setPrefs({ language: "pt-BR" });
  resetUiForTests();
  useSelection.setState({ selection: null, selectionTool: null });
  useDocs.getState().add([tiff]);
  useUi.setState({ page: 1 });
  render(<Viewport />);
  act(() => useUi.getState().setView({ scale: 1, panX: 0, panY: 0, mode: "actual" }));
});
afterEach(cleanup);

describe("página 2 maior que a primeira", () => {
  it("arrastar seleciona e move a seleção fora do tamanho da primeira página", () => {
    drag(vp(), [100, 200], [300, 500]);
    expect(selection()).toEqual({ type: "rect", data: { x: 100, y: 200, w: 200, h: 300 } });
    // Arrastar dentro da seleção a move, presa à página 2 (600x800), não à primeira (40x30).
    drag(vp(), [150, 250], [250, 350]);
    expect(selection()).toEqual({ type: "rect", data: { x: 200, y: 300, w: 200, h: 300 } });
  });

  it("a prévia ao vivo do Ajustar Cor pede a região visível da página 2", async () => {
    act(() => showPreview(1, { exposure: 1 } as never));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("preview_adjust", expect.anything()));
    const args = invoke.mock.calls.find(([c]) => c === "preview_adjust")![1]!;
    // 800x600 de tela em 1:1 mostram só o alto da página de 600x800.
    expect(args).toMatchObject({ id: 1, frame: 1, region: { x: 0, y: 0, w: 600, h: 600 } });
  });
});
