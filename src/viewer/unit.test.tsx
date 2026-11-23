// L14: "100% corresponde a" um pixel da tela ou ao tamanho impresso (ppp do documento e da tela).
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo } from "../ipc/types";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));

import { resetDocsForTests, useDocs } from "../store/docs";
import { resetPrefsForTests, setPrefs } from "../store/prefs";
import { resetUiForTests, useUi } from "../store/ui";
import { actualSize, fitToWindow, syncView, toggleFitActual, zoomIn } from "./actions";
import { loadUnit, resetUnitForTests, zoomUnit } from "./unit";
import { Viewport } from "./Viewport";

const info = (id: number, extra: Partial<DocInfo> = {}): DocInfo => ({
  id, path: `/p/${id}.png`, name: `${id}.png`, format: "png", width: 4000, height: 3000, frames: 1,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 0, error: null, ...extra,
});

let dpi: number | null = 300;
let ppi: number | null = 100;
const setDpr = (v: number) => Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: v });
const view = () => useUi.getState().view!;

beforeAll(() => {
  class RO {
    constructor(private cb: () => void) {}
    observe(el: Element) {
      Object.defineProperty(el, "clientWidth", { configurable: true, value: 800 });
      Object.defineProperty(el, "clientHeight", { configurable: true, value: 600 });
      this.cb();
    }
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", RO);
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement["getContext"];
});

beforeEach(() => {
  dpi = 300;
  ppi = 100;
  setDpr(1);
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) =>
    cmd === "document_dpi" ? dpi : cmd === "screen_ppi" ? ppi : cmd === "render_view" ? new Uint8Array([1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 255]).buffer : undefined,
  );
  resetDocsForTests();
  resetPrefsForTests();
  resetUiForTests();
  resetUnitForTests();
  setPrefs({ language: "pt-BR", actualSize: "print" });
  useUi.getState().setViewSize({ w: 800, h: 600 });
  useDocs.getState().add([info(1)]);
  syncView(true);
});
afterEach(() => {
  cleanup();
  setDpr(1);
});

describe("tamanho impresso", () => {
  it("100% mostra a imagem no tamanho do papel: 300 ppp numa tela de 100 px por polegada é 1/3", async () => {
    await loadUnit(1);
    actualSize();
    expect(view().scale).toBeCloseTo(1 / 3, 9);
    expect(view().mode).toBe("actual");
    expect(view().scale * zoomUnit()).toBeCloseTo(1, 9);
  });

  it("não depende da escala da tela (a medida já é em px CSS)", async () => {
    setDpr(2);
    await loadUnit(1);
    actualSize();
    expect(view().scale).toBeCloseTo(1 / 3, 9);
  });

  it("sem ppp no arquivo vale 72; sem tamanho do monitor, 96", async () => {
    dpi = null;
    ppi = null;
    await loadUnit(1);
    expect(zoomUnit()).toBeCloseTo(72 / 96, 9);
  });

  it("ppp absurdo do arquivo é ignorado", async () => {
    for (const bad of [0, -3, Number.NaN, 1e9]) {
      dpi = bad;
      await loadUnit(1);
      expect(zoomUnit(), String(bad)).toBeCloseTo(72 / 100, 9);
    }
  });

  it("falha ao perguntar não deixa a escala quebrada", async () => {
    invoke.mockRejectedValue(new Error("x"));
    await loadUnit(1);
    expect(zoomUnit()).toBeCloseTo(72 / 96, 9);
  });

  it("Ajustar à Janela continua limitado ao pixel da tela, e o duplo clique alterna com o tamanho impresso", async () => {
    await loadUnit(1);
    fitToWindow();
    expect(view().scale).toBeCloseTo(0.2, 9);
    toggleFitActual({ x: 400, y: 300 });
    expect(view().scale).toBeCloseTo(1 / 3, 9);
  });

  it("Ampliar anda nos degraus do zoom mostrado", async () => {
    await loadUnit(1);
    actualSize();
    zoomIn();
    expect(view().scale * zoomUnit()).toBeCloseTo(1.25, 9);
  });

  it("um ppp por documento", async () => {
    await loadUnit(1);
    useDocs.getState().add([info(2)]);
    dpi = 200;
    await loadUnit(2);
    useDocs.getState().setActive(2);
    expect(zoomUnit()).toBeCloseTo(2, 9);
    useDocs.getState().setActive(1);
    expect(zoomUnit()).toBeCloseTo(3, 9);
  });
});

describe("pixel da tela (padrão)", () => {
  it("100% é um pixel da imagem por pixel físico, sem perguntar o ppp", async () => {
    setPrefs({ actualSize: "pixel" });
    setDpr(2);
    actualSize();
    expect(view().scale).toBe(0.5);
    render(<Viewport />);
    await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
    expect(invoke.mock.calls.some(([c]) => c === "document_dpi" || c === "screen_ppi")).toBe(false);
  });
});

describe("Viewport", () => {
  it("trocar a preferência refaz a view no Tamanho Real, e o indicador mostra 100%", async () => {
    setPrefs({ actualSize: "pixel" });
    render(<Viewport />);
    act(() => actualSize());
    expect(screen.getByTestId("zoom-level").dataset.scale).toBe("1");
    await act(async () => {
      setPrefs({ actualSize: "print" });
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(view().scale).toBeCloseTo(1 / 3, 4);
    expect(screen.getByTestId("zoom-level").dataset.scale).toBe("1");
  });

  it("ao voltar o foco à janela (talvez em outro monitor), relê o ppi da tela", async () => {
    render(<Viewport />);
    await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
    expect(zoomUnit()).toBeCloseTo(3, 9);
    ppi = 200;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(zoomUnit()).toBeCloseTo(1.5, 9);
  });

  it("TIFF: cada página tem o próprio ppp", async () => {
    invoke.mockImplementation(async (cmd: string, args?: { frame?: number }) =>
      cmd === "document_dpi" ? ((args?.frame ?? 0) === 1 ? 150 : 300) : cmd === "screen_ppi" ? ppi : undefined,
    );
    resetDocsForTests();
    useDocs.getState().add([info(1, { format: "tiff", frames: 2, pageSizes: [[4000, 3000], [400, 300]] })]);
    render(<Viewport />);
    await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
    expect(zoomUnit()).toBeCloseTo(3, 9);
    await act(async () => {
      useUi.setState({ page: 1 });
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(zoomUnit()).toBeCloseTo(1.5, 9);
  });
});
