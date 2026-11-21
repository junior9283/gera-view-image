import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo } from "../ipc/types";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({}) }));

import { resetDocsForTests, useDocs } from "../store/docs";
import { resetPrefsForTests, setPrefs } from "../store/prefs";
import { resetUiForTests, useUi } from "../store/ui";
import { registerSlot, resetSlotsForTests } from "../lib/slots";
import { LENS_SIZE, LENS_ZOOM, Magnifier, resetMagnifierForTests, toggleMagnifier } from "./Magnifier";
import { Viewport } from "./Viewport";

const info = (id: number, extra: Partial<DocInfo> = {}): DocInfo => ({
  id, path: `/p/${id}.png`, name: `${id}.png`, format: "png", width: 4000, height: 3000, frames: 1,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 0, error: null, ...extra,
});

const buf = () => new Uint8Array([1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 255]).buffer;

/** Contexto 2D falso (o jsdom não tem canvas): registra os retângulos pintados com xadrez. */
const checkerFills: unknown[] = [];
const PATTERN = { pattern: true };
function fakeContext(this: HTMLCanvasElement) {
  return {
    canvas: this,
    fillStyle: "",
    imageSmoothingEnabled: true,
    setTransform() {},
    clearRect() {},
    putImageData() {},
    drawImage() {},
    createPattern: () => PATTERN,
    fillRect(this: { fillStyle: unknown }, ...r: number[]) {
      if (this.fillStyle === PATTERN) checkerFills.push(r);
    },
  };
}

beforeAll(() => {
  class RO {
    constructor(private cb: ResizeObserverCallback) {}
    observe(el: Element) {
      Object.defineProperty(el, "clientWidth", { configurable: true, value: 800 });
      Object.defineProperty(el, "clientHeight", { configurable: true, value: 600 });
      this.cb([], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", RO);
  vi.stubGlobal("ImageData", class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} });
  HTMLCanvasElement.prototype.getContext = fakeContext as unknown as HTMLCanvasElement["getContext"];
});

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => (cmd === "render_view" ? buf() : undefined));
  checkerFills.length = 0;
  resetDocsForTests();
  resetPrefsForTests();
  setPrefs({ language: "pt-BR" });
  resetUiForTests();
  resetSlotsForTests();
  resetMagnifierForTests();
  registerSlot("viewport-overlay", "magnifier", Magnifier);
});
afterEach(cleanup);

const wait = (ms = 80) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const lensCalls = () => invoke.mock.calls.filter((c) => c[0] === "render_view" && c[1].region && c[1].region.w < 1000);

describe("Mostrar Lupa", () => {
  beforeEach(() => {
    useDocs.getState().add([info(1)]);
    render(<Viewport />);
    // 0,2 px de tela por px da imagem, imagem a partir de (0, 0).
    act(() => useUi.getState().setView({ scale: 0.2, panX: 0, panY: 0, mode: "free" }));
  });

  it("começa desligada e alterna", () => {
    fireEvent.pointerMove(window, { clientX: 100, clientY: 100 });
    expect(screen.queryByTestId("magnifier")).toBeNull();
    act(() => toggleMagnifier());
    fireEvent.pointerMove(window, { clientX: 100, clientY: 100 });
    expect(screen.getByTestId("magnifier")).toBeTruthy();
    act(() => toggleMagnifier());
    expect(screen.queryByTestId("magnifier")).toBeNull();
  });

  it("segue o ponteiro, centrada nele", () => {
    act(() => toggleMagnifier());
    fireEvent.pointerMove(window, { clientX: 300, clientY: 200 });
    const lens = screen.getByTestId("magnifier");
    expect(lens.style.left).toBe(`${300 - LENS_SIZE / 2}px`);
    expect(lens.style.top).toBe(`${200 - LENS_SIZE / 2}px`);
  });

  it("pede ao núcleo só a região sob a lente, em resolução maior que a da tela", async () => {
    act(() => toggleMagnifier());
    fireEvent.pointerMove(window, { clientX: 300, clientY: 200 });
    await wait();
    const call = lensCalls().pop()!;
    expect(call).toBeTruthy();
    const { region, maxW } = call[1];
    // Ponto sob o ponteiro: (1500, 1000) px da imagem; a lente cobre LENS_SIZE / (0,2 × zoom) px.
    const half = LENS_SIZE / 2 / (0.2 * LENS_ZOOM);
    expect(region.x).toBeLessThanOrEqual(1500 - half);
    expect(region.x + region.w).toBeGreaterThanOrEqual(1500 + half);
    expect(region.y).toBeLessThanOrEqual(1000 - half);
    expect(region.y + region.h).toBeGreaterThanOrEqual(1000 + half);
    expect(maxW / region.w).toBeCloseTo(Math.min(1, 0.2 * LENS_ZOOM), 1);
  });

  it("movimento pequeno reaproveita o buffer (sem novo pedido)", async () => {
    act(() => toggleMagnifier());
    fireEvent.pointerMove(window, { clientX: 300, clientY: 200 });
    await wait();
    const n = lensCalls().length;
    fireEvent.pointerMove(window, { clientX: 305, clientY: 203 });
    await wait();
    expect(lensCalls().length).toBe(n);
  });

  it("some quando o ponteiro sai da área da imagem", () => {
    act(() => toggleMagnifier());
    fireEvent.pointerMove(window, { clientX: 300, clientY: 200 });
    fireEvent.pointerMove(window, { clientX: 5000, clientY: 200 });
    expect(screen.queryByTestId("magnifier")).toBeNull();
  });
});

describe("Mostrar Fundo da Imagem", () => {
  it("o xadrez atrás da imagem segue a preferência", async () => {
    useDocs.getState().add([info(1)]);
    render(<Viewport />);
    await wait(120);
    expect(checkerFills.length).toBeGreaterThan(0);
    checkerFills.length = 0;
    act(() => setPrefs({ showImageBackground: false }));
    await wait(10);
    expect(checkerFills.length).toBe(0);
  });
});
