import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo } from "../ipc/types";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
const setFullscreen = vi.fn(async () => {});
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setFullscreen }) }));

import { resetDocsForTests, useDocs } from "../store/docs";
import { resetPrefsForTests, setPrefs } from "../store/prefs";
import { resetUiForTests, useUi } from "../store/ui";
import { useSelection } from "../store/selection";
import { registerSlot, type OverlayProps } from "../lib/slots";
import { Viewport } from "./Viewport";
import { Slideshow } from "./Slideshow";
import { Sidebar } from "../sidebar/Sidebar";
import { ContactSheet } from "../sidebar/ContactSheet";

const info = (id: number, extra: Partial<DocInfo> = {}): DocInfo => ({
  id, path: `/p/${id}.png`, name: `${id}.png`, format: "png", width: 4000, height: 3000, frames: 1,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 0, error: null, ...extra,
});

/** Buffer de 1x1 no formato do IPC. */
const buf = () => new Uint8Array([1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 255]).buffer;

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
  class IO {
    constructor(private cb: IntersectionObserverCallback) {}
    observe(el: Element) {
      this.cb([{ isIntersecting: true, target: el } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", RO);
  vi.stubGlobal("IntersectionObserver", IO);
  // jsdom não tem canvas 2D.
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement["getContext"];
});

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => (cmd === "render_view" || cmd === "thumbnail" ? buf() : undefined));
  resetDocsForTests();
  resetPrefsForTests();
  setPrefs({ language: "pt-BR" });
  resetUiForTests();
  useSelection.setState({ selection: null, selectionTool: null });
});
afterEach(cleanup);

describe("Viewport", () => {
  it("mostra o estado de erro só no documento com erro", () => {
    useDocs.getState().add([info(1), info(2, { name: "truncado.jpg", error: "corrupt" })]);
    render(<Viewport />);
    expect(screen.queryByTestId("doc-error")).toBeNull();
    act(() => useDocs.getState().setActive(2));
    const err = screen.getByTestId("doc-error");
    expect(err.textContent).toContain("O arquivo está corrompido ou incompleto.");
    expect(err.textContent).toContain("truncado.jpg");
  });

  it("código desconhecido cai na mensagem genérica", () => {
    useDocs.getState().add([info(1, { error: "xyz" as DocInfo["error"] })]);
    render(<Viewport />);
    expect(screen.getByTestId("doc-error").textContent).toContain("Erro desconhecido");
  });

  it("ajusta à janela ao abrir, pede render_view e duplo clique alterna para 100 %", async () => {
    useDocs.getState().add([info(1)]);
    render(<Viewport />);
    const zoom = screen.getByTestId("zoom-level");
    expect(zoom.dataset.scale).toBe("0.2");
    await act(async () => void (await new Promise((r) => setTimeout(r, 120))));
    expect(invoke).toHaveBeenCalledWith("render_view", expect.objectContaining({ id: 1, frame: 0 }));
    fireEvent.doubleClick(screen.getByTestId("viewport"), { clientX: 400, clientY: 300 });
    expect(zoom.dataset.scale).toBe("1");
    fireEvent.doubleClick(screen.getByTestId("viewport"), { clientX: 400, clientY: 300 });
    expect(zoom.dataset.scale).toBe("0.2");
  });

  it("acima de 100 % pede só a região visível", async () => {
    useDocs.getState().add([info(1)]);
    render(<Viewport />);
    act(() => useUi.getState().setView({ scale: 2, panX: -1000, panY: -1000, mode: "free" }));
    await act(async () => void (await new Promise((r) => setTimeout(r, 120))));
    const call = invoke.mock.calls.filter((c) => c[0] === "render_view").pop()!;
    expect(call[1].region).not.toBeNull();
    expect(call[1].region.w).toBeLessThan(4000);
  });

  it("arraste move a imagem e termina em pointercancel", () => {
    useDocs.getState().add([info(1)]);
    render(<Viewport />);
    act(() => useUi.getState().setView({ scale: 1, panX: -100, panY: -100, mode: "actual" }));
    const vp = screen.getByTestId("viewport");
    vp.setPointerCapture = () => {};
    fireEvent.pointerDown(vp, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(vp, { clientX: 90, clientY: 80, pointerId: 1 });
    expect(useUi.getState().view).toMatchObject({ panX: -110, panY: -120 });
    fireEvent.pointerCancel(vp, { pointerId: 1 });
    fireEvent.pointerMove(vp, { clientX: 0, clientY: 0, pointerId: 1 });
    expect(useUi.getState().view).toMatchObject({ panX: -110, panY: -120 });
  });

  it("Ctrl+roda dá zoom", () => {
    useDocs.getState().add([info(1)]);
    render(<Viewport />);
    fireEvent.wheel(screen.getByTestId("viewport"), { ctrlKey: true, deltaY: -100, clientX: 400, clientY: 300 });
    expect(useUi.getState().view!.scale).toBeGreaterThan(0.2);
  });

  it("monta o slot viewport-overlay com a transformação da imagem", () => {
    const off = registerSlot<OverlayProps>("viewport-overlay", "teste", (p) => <div data-testid="ov" data-p={JSON.stringify(p)} />);
    useDocs.getState().add([info(1)]);
    render(<Viewport />);
    act(() => useUi.getState().setView({ scale: 0.5, panX: 10, panY: 20, mode: "free" }));
    expect(JSON.parse(screen.getByTestId("ov").dataset.p!)).toEqual({ scale: 0.5, panX: 10, panY: 20, imageW: 4000, imageH: 3000 });
    off();
  });

  it("a camada de seleção registrada por src/select aparece sobre a imagem", async () => {
    await import("../select/register");
    useDocs.getState().add([info(1)]);
    render(<Viewport />);
    expect(screen.getByTestId("viewport").querySelector(".viewport-overlay canvas")).not.toBeNull();
  });

  it("com ferramenta de seleção o botão esquerdo não faz pan; o do meio e Espaço+esquerdo fazem", () => {
    useDocs.getState().add([info(1)]);
    useSelection.getState().setSelectionTool("rect");
    render(<Viewport />);
    act(() => useUi.getState().setView({ scale: 1, panX: -100, panY: -100, mode: "actual" }));
    const vp = screen.getByTestId("viewport");
    vp.setPointerCapture = () => {};
    const drag = (button: number, dx: number) => {
      fireEvent.pointerDown(vp, { button, clientX: 100, clientY: 100, pointerId: 1 });
      fireEvent.pointerMove(vp, { clientX: 100 + dx, clientY: 100, pointerId: 1 });
      fireEvent.pointerUp(vp, { pointerId: 1 });
    };
    drag(0, -10);
    expect(useUi.getState().view).toMatchObject({ panX: -100 });
    drag(1, -10);
    expect(useUi.getState().view).toMatchObject({ panX: -110 });
    fireEvent.keyDown(window, { key: " ", code: "Space" });
    expect(vp.classList.contains("space-pan")).toBe(true);
    drag(0, -10);
    expect(useUi.getState().view).toMatchObject({ panX: -120 });
    fireEvent.keyUp(window, { key: " ", code: "Space" });
    drag(0, -10);
    expect(useUi.getState().view).toMatchObject({ panX: -120 });
    useSelection.getState().setSelectionTool(null);
    drag(0, -10);
    expect(useUi.getState().view).toMatchObject({ panX: -130 });
  });
});

describe("Sidebar", () => {
  it("lista os documentos, páginas e miniatura de erro; clique ativa", async () => {
    useDocs.getState().add([info(1), info(2, { name: "ruim.jpg", error: "corrupt" }), info(3, { format: "tiff", frames: 2 })]);
    render(<Sidebar />);
    expect(screen.getByText("ruim.jpg")).toBeTruthy();
    expect(screen.getAllByTestId("thumb-error")).toHaveLength(1);
    expect(screen.getByText("Página 2")).toBeTruthy();
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    expect(invoke).toHaveBeenCalledWith("thumbnail", expect.objectContaining({ id: 1, frame: 0 }));
    expect(invoke).not.toHaveBeenCalledWith("thumbnail", expect.objectContaining({ id: 2 }));
    fireEvent.click(screen.getByText("Página 2"));
    expect(useDocs.getState().activeId).toBe(3);
    expect(useUi.getState().page).toBe(1);
  });
});

describe("ContactSheet", () => {
  it("controle de tamanho limitado a 64–320 px", () => {
    useDocs.getState().add([info(1), info(2)]);
    render(<ContactSheet />);
    const slider = screen.getByLabelText("Tamanho das miniaturas") as HTMLInputElement;
    expect(slider.min).toBe("64");
    expect(slider.max).toBe("320");
    fireEvent.change(slider, { target: { value: "300" } });
    expect(useUi.getState().contactSize).toBe(300);
    fireEvent.doubleClick(screen.getByText("2.png"));
    expect(useDocs.getState().activeId).toBe(2);
    expect(useUi.getState().sidebar).toBe("thumbs");
  });
});

describe("Slideshow", () => {
  it("mostra índice, avança, pausa e sai", async () => {
    useDocs.getState().add([info(1), info(2), info(3)]);
    useUi.setState({ slideshow: true });
    render(<Slideshow />);
    expect(screen.getByText("1 de 3")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Próxima"));
    expect(useDocs.getState().activeId).toBe(2);
    fireEvent.click(screen.getByLabelText("Anterior"));
    fireEvent.click(screen.getByLabelText("Anterior"));
    expect(useDocs.getState().activeId).toBe(3);
    fireEvent.click(screen.getByLabelText("Pausar"));
    expect(screen.getByLabelText("Continuar")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Sair da apresentação"));
    await act(async () => {});
    expect(useUi.getState().slideshow).toBe(false);
  });

  it("Space pausa, mas não quando o foco está num botão", () => {
    useDocs.getState().add([info(1), info(2)]);
    useUi.setState({ slideshow: true });
    render(<Slideshow />);
    fireEvent.keyDown(document.body, { key: " " });
    expect(screen.getByLabelText("Continuar")).toBeTruthy();
    const btn = screen.getByLabelText("Continuar");
    btn.focus();
    fireEvent.keyDown(btn, { key: " " });
    expect(screen.getByLabelText("Continuar")).toBeTruthy();
  });

  it("avança sozinho depois de slideshowSeconds", async () => {
    vi.useFakeTimers();
    try {
      useDocs.getState().add([info(1), info(2)]);
      useUi.setState({ slideshow: true });
      render(<Slideshow />);
      await act(async () => void vi.advanceTimersByTime(3100));
      expect(useDocs.getState().activeId).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
