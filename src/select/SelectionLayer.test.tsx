import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mask } from "../ipc/types";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { useDocs } from "../store/docs";
import { useSelection } from "../store/selection";
import { SelectionLayer } from "./SelectionLayer";

const props = { docId: 1, imageWidth: 100, imageHeight: 80, scale: 2, panX: 10, panY: 10 };
const layer = () => screen.getByLabelText("Camada de seleção");
const bitmap: Mask = { type: "bitmap", data: { w: 100, h: 80, rle: [0, 10, 7990] } };

describe("SelectionLayer", () => {
  beforeEach(() => {
    invoke.mockReset();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null); // jsdom não tem canvas
    useSelection.setState({ selection: null, selectionTool: null });
    useDocs.setState({ docs: [], activeId: null });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("arrastar com a ferramenta retângulo cria a seleção em coordenadas da imagem", () => {
    useSelection.setState({ selectionTool: "rect" });
    render(<SelectionLayer {...props} />);
    fireEvent.pointerDown(layer(), { clientX: 30, clientY: 30, button: 0, pointerId: 1 });
    fireEvent.pointerMove(layer(), { clientX: 110, clientY: 90, pointerId: 1 });
    fireEvent.pointerUp(layer(), { clientX: 110, clientY: 90, pointerId: 1 });
    expect(useSelection.getState().selection).toEqual({ type: "rect", data: { x: 10, y: 10, w: 40, h: 30 } });
  });

  it("sem ferramenta a camada não captura o ponteiro", () => {
    render(<SelectionLayer {...props} />);
    expect(layer().style.pointerEvents).toBe("none");
  });

  it("Alfa Instantâneo: uma chamada por vez; cancelar o ponteiro descarta o resultado", async () => {
    useSelection.setState({ selectionTool: "instantAlpha" });
    const resolvers: ((m: Mask) => void)[] = [];
    invoke.mockImplementation(() => new Promise((ok) => resolvers.push(ok)));
    render(<SelectionLayer {...props} />);
    fireEvent.pointerDown(layer(), { clientX: 30, clientY: 30, button: 0, pointerId: 1 });
    fireEvent.pointerMove(layer(), { clientX: 130, clientY: 30, pointerId: 1 });
    fireEvent.pointerUp(layer(), { clientX: 230, clientY: 30, pointerId: 1 });
    expect(invoke).toHaveBeenCalledTimes(1); // a segunda espera a primeira
    resolvers[0](bitmap);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(invoke).toHaveBeenLastCalledWith("instant_alpha", { id: 1, x: 10, y: 10, tolerance: 200 / 300 });
    resolvers[1](bitmap);
    await vi.waitFor(() => expect(useSelection.getState().selection).toEqual(bitmap));

    // Novo arrasto cancelado: o resultado que chega depois é descartado.
    useSelection.setState({ selection: null });
    invoke.mockClear();
    fireEvent.pointerDown(layer(), { clientX: 30, clientY: 30, button: 0, pointerId: 1 });
    fireEvent.pointerCancel(layer(), { pointerId: 1 });
    resolvers[2](bitmap);
    await act(async () => {});
    expect(useSelection.getState().selection).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("Enter com foco num campo de texto não aplica o Alfa Instantâneo", async () => {
    useSelection.setState({ selectionTool: "instantAlpha" });
    invoke.mockResolvedValue(bitmap);
    render(
      <>
        <SelectionLayer {...props} />
        <input aria-label="campo" />
      </>,
    );
    fireEvent.pointerDown(layer(), { clientX: 30, clientY: 30, button: 0, pointerId: 1 });
    await act(async () => {});
    fireEvent.pointerUp(layer(), { clientX: 30, clientY: 30, pointerId: 1 });
    await act(async () => {});
    invoke.mockClear();
    fireEvent.keyDown(screen.getByLabelText("campo"), { key: "Enter" });
    await act(async () => {});
    expect(invoke).not.toHaveBeenCalled();
  });

  it("laço magnético que volta com menos de 3 pontos não grava seleção", async () => {
    useSelection.setState({ selectionTool: "smartLasso" });
    invoke.mockResolvedValue([[1, 1], [2, 2]]);
    render(<SelectionLayer {...props} />);
    fireEvent.pointerDown(layer(), { clientX: 30, clientY: 30, button: 0, pointerId: 1 });
    fireEvent.pointerMove(layer(), { clientX: 60, clientY: 30, pointerId: 1 });
    fireEvent.pointerMove(layer(), { clientX: 60, clientY: 60, pointerId: 1 });
    fireEvent.pointerUp(layer(), { clientX: 60, clientY: 60, pointerId: 1 });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("snap_lasso", expect.anything()));
    await act(async () => {});
    expect(useSelection.getState().selection).toBeNull();
  });

  it("Alfa Instantâneo: prévia, aviso de formato sem alfa e Enter aplica makeTransparent", async () => {
    useSelection.setState({ selectionTool: "instantAlpha" });
    useDocs.setState({ activeId: 1 });
    invoke.mockImplementation(async (cmd: string) => (cmd === "instant_alpha" ? bitmap : { id: 1, rev: 1 }));
    render(<SelectionLayer {...props} format="jpeg" />);
    fireEvent.pointerDown(layer(), { clientX: 30, clientY: 30, button: 0, pointerId: 1 });
    await act(async () => {});
    fireEvent.pointerUp(layer(), { clientX: 30, clientY: 30, pointerId: 1 });
    await act(async () => {});
    expect(invoke).toHaveBeenCalledWith("instant_alpha", { id: 1, x: 10, y: 10, tolerance: 0 });
    expect(screen.getByRole("status").textContent).toContain("PNG");
    fireEvent.keyDown(window, { key: "Enter" });
    await act(async () => {});
    expect(invoke).toHaveBeenCalledWith("apply_op", { id: 1, op: { type: "makeTransparent", data: bitmap } });
  });

  it("Alfa Instantâneo pendente consome Delete e Esc antes do keymap global (sem Op em dobro)", async () => {
    useSelection.setState({ selectionTool: "instantAlpha" });
    invoke.mockImplementation(async (cmd: string) => (cmd === "instant_alpha" ? bitmap : { id: 1, rev: 1 }));
    // Registrado antes da camada, como o useShortcuts do App: só age se ninguém consumiu a tecla.
    const global = vi.fn((e: KeyboardEvent) => e.defaultPrevented);
    window.addEventListener("keydown", global);
    render(<SelectionLayer {...props} />);
    const pend = async () => {
      fireEvent.pointerDown(layer(), { clientX: 30, clientY: 30, button: 0, pointerId: 1 });
      await act(async () => {});
      fireEvent.pointerUp(layer(), { clientX: 30, clientY: 30, pointerId: 1 });
      await act(async () => {});
    };
    await pend();
    fireEvent.keyDown(window, { key: "Delete" });
    await act(async () => {});
    await pend();
    fireEvent.keyDown(window, { key: "Escape" });
    window.removeEventListener("keydown", global);
    expect(global.mock.results.map((r) => r.value)).toEqual([true, true]);
  });

  describe("formigas marchando", () => {
    const setHidden = (hidden: boolean) => Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    const ctx = () => ({
      setTransform: vi.fn(), clearRect: vi.fn(), drawImage: vi.fn(), putImageData: vi.fn(),
      createImageData: vi.fn((w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) })),
    });
    let c: ReturnType<typeof ctx>;
    beforeEach(() => {
      vi.useFakeTimers();
      c = ctx();
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(c as never);
      useSelection.setState({ selection: bitmap });
    });
    afterEach(() => {
      setHidden(false);
      vi.useRealTimers();
    });

    it("pausam com a aba oculta e retomam ao voltar", () => {
      render(<SelectionLayer {...props} />);
      const draws = () => c.clearRect.mock.calls.length;
      vi.advanceTimersByTime(300);
      const running = draws();
      expect(running).toBeGreaterThan(1);
      setHidden(true);
      vi.advanceTimersByTime(1000);
      expect(draws()).toBe(running);
      setHidden(false);
      document.dispatchEvent(new Event("visibilitychange"));
      expect(draws()).toBe(running + 1);
      vi.advanceTimersByTime(200);
      expect(draws()).toBe(running + 3);
    });

    it("o contorno Bitmap usa canvases pré-renderizados: no máximo 1 por fase, reaproveitados", () => {
      render(<SelectionLayer {...props} />);
      vi.advanceTimersByTime(100 * 40); // várias voltas completas das fases
      const edgeDraws = c.drawImage.mock.calls.length;
      expect(edgeDraws).toBeGreaterThan(30);
      // createImageData: só os frames de contorno (<= 8 fases); nada por célula/por quadro.
      expect(c.createImageData.mock.calls.length).toBeLessThanOrEqual(8);
    });
  });
});
