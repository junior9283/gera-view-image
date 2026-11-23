// Ajustar Cor ao vivo na imagem do visor (L4): região visível, teto de pixels, pedidos antigos e restauração.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Buf = { width: number; height: number; data: Uint8ClampedArray };
const ipc = vi.hoisted(() => ({
  previewAdjust: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  histogram: vi.fn(async () => ({ r: [], g: [], b: [], l: [] })),
  autoLevels: vi.fn(),
  applyOp: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
}));
vi.mock("../ipc/commands", () => ipc);

import type { DocInfo } from "../ipc/types";
import { Slot } from "../lib/slots";
import { resetDocsForTests, useDocs } from "../store/docs";
import { resetPrefsForTests, setPrefs } from "../store/prefs";
import { useThumbSelection } from "../sidebar/selection";
import { resetUiForTests, useUi } from "../store/ui";
import { AdjustHost } from "./AdjustHost";
import { openAdjustColor } from "./actions";
import { useAdjustPreview } from "./preview";
import { LIVE_PIXELS, SETTLE_MS } from "./AdjustPreviewLayer";
import "./register";

const doc = (id: number, over: Partial<DocInfo> = {}): DocInfo => ({
  id, path: `/p/${id}.png`, name: `${id}.png`, format: "png", width: 4000, height: 3000, frames: 1,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 1, error: null, ...over,
});

const buffer = (): Buf => ({ width: 2, height: 2, data: new Uint8ClampedArray(16) });

/** O que o Viewport faz em volta do slot. */
function Viewer() {
  const view = useUi((s) => s.view);
  const d = useDocs((s) => s.docs.find((x) => x.id === s.activeId));
  return (
    <div className="viewport">
      <canvas className="viewport-canvas" data-testid="base" />
      {view && d && (
        <div className="viewport-overlay">
          <Slot name="viewport-overlay" props={{ scale: view.scale, panX: view.panX, panY: view.panY, imageW: d.width, imageH: d.height }} />
        </div>
      )}
    </div>
  );
}

const base = () => screen.getByTestId("base");
const layer = () => screen.queryByRole("img", { name: "Prévia do ajuste" });
const slider = () => screen.getByLabelText("Exposição", { selector: "input" });
const expose = (v: number) => fireEvent.change(slider(), { target: { value: String(v) } });
const tick = (ms = 60) => act(() => vi.advanceTimersByTimeAsync(ms));
const calls = () => ipc.previewAdjust.mock.calls as [number, { exposure: number }, number, number, number, unknown][];

const draw = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  ipc.previewAdjust.mockImplementation(async () => buffer());
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    clearRect: vi.fn(), fillRect: vi.fn(), putImageData: vi.fn(), setTransform: vi.fn(), drawImage: draw, createPattern: vi.fn(() => null),
  })) as never;
  vi.stubGlobal("ImageData", class { constructor(public data: unknown, public width: number, public height: number) {} });
  resetDocsForTests();
  resetUiForTests();
  resetPrefsForTests();
  setPrefs({ language: "pt-BR" });
  useAdjustPreview.setState({ cur: null, failed: false });
  useThumbSelection.setState({ picked: [], anchor: null });
  useDocs.setState({ docs: [doc(1), doc(2)], activeId: 1 });
  useUi.setState({ viewSize: { w: 800, h: 600 }, view: { scale: 0.2, panX: 0, panY: 0, mode: "fit" } });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const open = () => {
  render(
    <>
      <Viewer />
      <AdjustHost />
    </>,
  );
  act(() => openAdjustColor());
};

describe("prévia no visor", () => {
  it("o painel não tem mais miniatura e, sem ajuste, a imagem fica como está", async () => {
    open();
    await tick();
    expect(screen.getByRole("dialog").querySelector(".adjust-preview")).toBeNull();
    expect(ipc.previewAdjust).not.toHaveBeenCalled();
    expect(layer()).toBeNull();
    expect(base().style.visibility).toBe("");
  });

  it("o ajuste aparece por cima da imagem, que fica escondida (o alfa não mostra o original)", async () => {
    open();
    expose(1);
    await tick();
    expect(calls()[0]).toEqual([1, expect.objectContaining({ exposure: 1 }), 800, 600, 0, null]);
    expect(layer()).toBeTruthy();
    expect(base().style.visibility).toBe("hidden");
    expect(draw.mock.lastCall?.slice(1)).toEqual([0, 0, 800, 600]);
  });

  it("com zoom, pede só a região visível, na resolução nativa, e acompanha o arraste da vista", async () => {
    useUi.setState({ view: { scale: 2, panX: -1000, panY: -400, mode: "free" } });
    open();
    expose(1);
    await tick();
    expect(calls()[0].slice(2)).toEqual([400, 300, 0, { x: 500, y: 200, w: 400, h: 300 }]);
    act(() => useUi.setState({ view: { scale: 2, panX: -1200, panY: -400, mode: "free" } }));
    // Até chegar a região nova, a parte que falta é a imagem sem ajuste (não um buraco).
    expect(base().style.visibility).toBe("");
    await tick();
    expect(calls()[calls().length - 1][5]).toEqual({ x: 600, y: 200, w: 400, h: 300 });
    expect(base().style.visibility).toBe("hidden");
  });

  it("documento de várias páginas: só a página mostrada", async () => {
    useDocs.setState({ docs: [doc(1, { frames: 5, format: "tiff" })], activeId: 1 });
    useUi.setState({ page: 3 });
    open();
    expose(1);
    await tick();
    expect(calls()[0][4]).toBe(3);
  });
});

describe("custo", () => {
  it("durante o arraste a prévia tem teto de pixels; parado, vem a nítida", async () => {
    useUi.setState({ viewSize: { w: 3840, h: 2160 }, view: { scale: 0.96, panX: 0, panY: 0, mode: "free" } });
    open();
    expose(1);
    await tick();
    const [, , w, h] = calls()[0];
    expect(w * h).toBeLessThanOrEqual(LIVE_PIXELS);
    expect(calls()).toHaveLength(1);
    await tick(SETTLE_MS);
    expect(calls()).toHaveLength(2);
    expect(calls()[1][2] * calls()[1][3]).toBeGreaterThan(LIVE_PIXELS);
  });

  it("um pedido por vez: os do meio do arraste são trocados pelo último", async () => {
    const done: ((b: Buf) => void)[] = [];
    ipc.previewAdjust.mockImplementation(() => new Promise((r) => done.push(r)));
    open();
    expose(0.5);
    await tick();
    for (const v of [0.6, 0.7, 0.8]) {
      expose(v);
      await tick();
    }
    expect(calls()).toHaveLength(1);
    await act(async () => done[0](buffer()));
    expect(calls().map((c) => c[1].exposure)).toEqual([0.5, 0.8]);
  });

  it("resposta que chega depois de redefinir não aparece", async () => {
    let finish!: (b: Buf) => void;
    ipc.previewAdjust.mockImplementation(() => new Promise((r) => (finish = r)));
    open();
    expose(1);
    await tick();
    fireEvent.click(screen.getByText("Redefinir Tudo"));
    await act(async () => finish(buffer()));
    expect(layer()).toBeNull();
    expect(base().style.visibility).toBe("");
  });

  it("falha na prévia mostra a imagem original e avisa no painel", async () => {
    ipc.previewAdjust.mockRejectedValue(new Error("x"));
    open();
    expose(1);
    await tick();
    expect(screen.getByRole("alert").textContent).toBe("Não foi possível gerar a prévia.");
    expect(base().style.visibility).toBe("");
  });
});

describe("restaura", () => {
  it("ao cancelar", async () => {
    open();
    expose(1);
    await tick();
    fireEvent.click(screen.getByText("Cancelar"));
    expect(layer()).toBeNull();
    expect(base().style.visibility).toBe("");
    expect(ipc.applyOp).not.toHaveBeenCalled();
  });

  it("ao mudar de documento, sem levar o ajuste para o outro", async () => {
    open();
    expose(1);
    await tick();
    act(() => useDocs.setState({ activeId: 2 }));
    await tick();
    expect(layer()).toBeNull();
    expect(base().style.visibility).toBe("");
    expect(calls().every(([id]) => id === 1)).toBe(true);
  });

  it("OK mantém a prévia na tela até o visor mostrar a imagem já ajustada (sem piscar nem ajustar duas vezes)", async () => {
    ipc.applyOp.mockImplementation(async () => doc(1, { rev: 2 }));
    open();
    expose(1);
    await tick();
    const before = calls().length;
    fireEvent.click(screen.getByText("OK"));
    await tick(0);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useDocs.getState().docs[0].rev).toBe(2);
    expect(layer()).toBeTruthy();
    expect(base().style.visibility).toBe("hidden");
    await tick(SETTLE_MS);
    expect(calls()).toHaveLength(before);

    await act(async () => base().setAttribute("data-shown", "1:2"));
    await tick(0);
    expect(layer()).toBeNull();
    expect(base().style.visibility).toBe("");
  });

  it("OK numa imagem que demora a desenhar: a prévia fica até a revisão nova aparecer, sem prazo curto", async () => {
    ipc.applyOp.mockImplementation(async () => doc(1, { rev: 2 }));
    open();
    expose(1);
    await tick();
    fireEvent.click(screen.getByText("OK"));
    await tick(0);
    await tick(10_000);
    expect(layer()).toBeTruthy();
    await act(async () => base().setAttribute("data-shown", "1:2"));
    await tick(0);
    expect(layer()).toBeNull();
  });

  it("OK e o visor não consegue desenhar a revisão nova: a prévia sai (sem ficar presa)", async () => {
    ipc.applyOp.mockImplementation(async () => doc(1, { rev: 2 }));
    open();
    expose(1);
    await tick();
    fireEvent.click(screen.getByText("OK"));
    await tick(0);
    await act(async () => base().setAttribute("data-failed", "1:2"));
    await tick(0);
    expect(layer()).toBeNull();
    expect(base().style.visibility).toBe("");
  });

  it("OK com pedidos no meio: nada mais é pedido nem mostrado (a imagem já teria o ajuste)", async () => {
    let finish!: (b: Buf) => void;
    ipc.previewAdjust.mockImplementation(() => new Promise((r) => (finish = r)));
    ipc.applyOp.mockImplementation(async () => doc(1, { rev: 2 }));
    open();
    expose(0.5);
    await tick();
    expose(0.8);
    await tick();
    fireEvent.click(screen.getByText("OK"));
    await tick(0);
    await act(async () => finish(buffer()));
    await tick(SETTLE_MS);
    expect(calls()).toHaveLength(1);
    expect(layer()).toBeNull();
    expect(base().style.visibility).toBe("");
  });

  it("OK que falha volta à prévia ao vivo", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    ipc.applyOp.mockRejectedValue({ code: "io", message: "x" });
    open();
    expose(1);
    await tick();
    fireEvent.click(screen.getByText("OK"));
    await tick(0);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expose(0.5);
    await tick();
    expect(calls()[calls().length - 1][1].exposure).toBe(0.5);
  });
});
