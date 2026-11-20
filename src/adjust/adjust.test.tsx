import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  previewAdjust: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ width: 2, height: 2, data: new Uint8ClampedArray(16) })),
  histogram: vi.fn(async () => ({ r: Array(256).fill(1), g: Array(256).fill(1), b: Array(256).fill(1), l: Array(256).fill(1) })),
  autoLevels: vi.fn(async () => ({ ...NEUTRAL_ADJUST, levels: { black: 10, gamma: 1, white: 240 } })),
  applyOp: vi.fn(async () => ({ id: 1, rev: 2 })),
}));
vi.mock("../ipc/commands", () => ipc);

import { useDocs } from "../store/docs";
import { NEUTRAL_ADJUST, type DocInfo } from "../ipc/types";
import { AdjustColorPanel, PREVIEW_THROTTLE_MS } from "./AdjustColorPanel";
import { ResizeDialog } from "./ResizeDialog";

const doc = { id: 1, width: 4000, height: 3000, rev: 1, error: null } as DocInfo;

beforeEach(() => {
  vi.clearAllMocks();
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    clearRect: vi.fn(), fillRect: vi.fn(), putImageData: vi.fn(),
  })) as never;
  vi.stubGlobal("ImageData", class { constructor(public data: unknown, public width: number, public height: number) {} });
  useDocs.setState({ docs: [doc], activeId: 1 });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("AdjustColorPanel", () => {
  it("faz a prévia com throttle e aplica o ajuste ao confirmar", async () => {
    vi.useFakeTimers();
    const apply = vi.spyOn(useDocs.getState(), "applyOp");
    useDocs.setState({ applyOp: ipc.applyOp as never });
    const onClose = vi.fn();
    render(createElement(AdjustColorPanel, { docId: 1, onClose }));
    await act(() => vi.advanceTimersByTimeAsync(PREVIEW_THROTTLE_MS));
    const before = ipc.previewAdjust.mock.calls.length;
    const slider = screen.getByLabelText("Exposição", { selector: "input" });
    for (const v of ["0.5", "1", "1.5"]) fireEvent.change(slider, { target: { value: v } });
    await act(() => vi.advanceTimersByTimeAsync(PREVIEW_THROTTLE_MS * 2));
    expect(ipc.previewAdjust.mock.calls.length - before).toBe(1);
    expect(ipc.previewAdjust.mock.lastCall?.[1]).toMatchObject({ exposure: 1.5 });

    fireEvent.click(screen.getByText("OK"));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(ipc.applyOp).toHaveBeenCalledWith(1, { type: "adjust", data: expect.objectContaining({ exposure: 1.5 }) });
    expect(onClose).toHaveBeenCalled();
    apply.mockRestore();
  });

  it("Ajuste Automático carrega os níveis e Redefinir Tudo volta ao neutro", async () => {
    render(createElement(AdjustColorPanel, { docId: 1, onClose: () => {} }));
    fireEvent.click(screen.getByText("Ajuste Automático"));
    await vi.waitFor(() => expect((screen.getByLabelText("Nível de preto") as HTMLInputElement).value).toBe("10"));
    fireEvent.click(screen.getByText("Redefinir Tudo"));
    expect((screen.getByLabelText("Nível de preto") as HTMLInputElement).value).toBe("0");
  });

  it("Esc fecha o painel e consome a tecla (o keymap global não desmarca a seleção)", () => {
    const onClose = vi.fn();
    const global = vi.fn((e: KeyboardEvent) => e.defaultPrevented);
    window.addEventListener("keydown", global);
    render(createElement(AdjustColorPanel, { docId: 1, onClose }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    window.removeEventListener("keydown", global);
    expect(onClose).toHaveBeenCalled();
    expect(global.mock.results.every((r) => r.value)).toBe(true);
  });

  it("OK sem mudanças não grava operação", () => {
    const onClose = vi.fn();
    render(createElement(AdjustColorPanel, { docId: 1, onClose }));
    fireEvent.click(screen.getByText("OK"));
    expect(ipc.applyOp).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});

describe("ResizeDialog", () => {
  beforeEach(() => useDocs.setState({ applyOp: ipc.applyOp as never }));

  it("proporcional ajusta a altura e aplica Resize", async () => {
    const onClose = vi.fn();
    render(createElement(ResizeDialog, { doc, onClose }));
    fireEvent.change(screen.getByLabelText("Largura"), { target: { value: "1000" } });
    expect((screen.getByLabelText("Altura") as HTMLInputElement).value).toBe("750");
    expect(screen.getByText("Tamanho resultante: 2.9 MB")).toBeTruthy();
    fireEvent.click(screen.getByText("OK"));
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(ipc.applyOp).toHaveBeenCalledWith(1, {
      type: "resize",
      data: { w: 1000, h: 750, filter: "lanczos3", dpi: 72 },
    });
  });

  it("sem reamostrar só muda o DPI, com w/h iguais", async () => {
    render(createElement(ResizeDialog, { doc, onClose: () => {} }));
    fireEvent.click(screen.getByLabelText("Reamostrar imagem"));
    fireEvent.change(screen.getByLabelText(/Resolução/), { target: { value: "300" } });
    fireEvent.click(screen.getByText("OK"));
    await vi.waitFor(() => expect(ipc.applyOp).toHaveBeenCalled());
    expect(ipc.applyOp).toHaveBeenCalledWith(1, {
      type: "resize",
      data: { w: 4000, h: 3000, filter: "lanczos3", dpi: 300 },
    });
  });

  it("preset define largura e altura", () => {
    render(createElement(ResizeDialog, { doc, onClose: () => {} }));
    fireEvent.change(screen.getByLabelText("Predefinição"), { target: { value: "5" } });
    expect((screen.getByLabelText("Largura") as HTMLInputElement).value).toBe("1920");
    expect((screen.getByLabelText("Altura") as HTMLInputElement).value).toBe("1080");
  });
});
