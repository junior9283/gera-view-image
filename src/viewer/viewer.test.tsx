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

  describe("Tamanho Real com escala da tela", () => {
    let ratio = 2;
    let media: { query: string; cb: () => void }[] = [];
    beforeEach(() => {
      ratio = 2;
      media = [];
      Object.defineProperty(window, "devicePixelRatio", { configurable: true, get: () => ratio });
      window.matchMedia = ((query: string) => ({
        matches: false,
        addEventListener: (_: string, cb: () => void) => media.push({ query, cb }),
        removeEventListener: (_: string, cb: () => void) => (media = media.filter((m) => m.cb !== cb)),
      })) as unknown as typeof window.matchMedia;
    });
    const matchMedia = window.matchMedia;
    afterEach(() => {
      window.matchMedia = matchMedia;
      Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1 });
    });

    it("100 % mostra 1 px da imagem por px físico e o indicador segue em 100 %", () => {
      useDocs.getState().add([info(1)]);
      render(<Viewport />);
      fireEvent.doubleClick(screen.getByTestId("viewport"), { clientX: 400, clientY: 300 });
      expect(useUi.getState().view).toMatchObject({ scale: 0.5, mode: "actual" });
      const zoom = screen.getByTestId("zoom-level");
      expect(zoom.dataset.scale).toBe("1");
      expect(zoom.textContent).toContain("100");
    });

    it("reage à mudança de escala da tela mantendo o Tamanho Real", () => {
      useDocs.getState().add([info(1)]);
      render(<Viewport />);
      fireEvent.doubleClick(screen.getByTestId("viewport"), { clientX: 400, clientY: 300 });
      expect(media.map((m) => m.query)).toContain("(resolution: 2dppx)");
      ratio = 1;
      act(() => media.forEach((m) => m.cb()));
      expect(useUi.getState().view).toMatchObject({ scale: 1, mode: "actual" });
      expect(screen.getByTestId("zoom-level").dataset.scale).toBe("1");
      expect(media.map((m) => m.query)).toEqual(["(resolution: 1dppx)"]);
    });

    it("Ctrl+roda parte do zoom mostrado e não salta", () => {
      useDocs.getState().add([info(1)]);
      render(<Viewport />);
      fireEvent.doubleClick(screen.getByTestId("viewport"), { clientX: 400, clientY: 300 });
      fireEvent.wheel(screen.getByTestId("viewport"), { ctrlKey: true, deltaY: -10, clientX: 400, clientY: 300 });
      const s = useUi.getState().view!.scale;
      expect(s).toBeGreaterThan(0.5);
      expect(s).toBeLessThan(0.6);
    });
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
    const armed = new KeyboardEvent("keydown", { key: " ", code: "Space", cancelable: true });
    window.dispatchEvent(armed);
    expect(armed.defaultPrevented).toBe(true);
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

  const item = (name: string) => screen.getByText(name).closest("button")!;
  const moveTo = (clientX: number, clientY: number) =>
    act(() => void window.dispatchEvent(new MouseEvent("pointermove", { clientX, clientY })));
  const startDragCalls = () => invoke.mock.calls.filter(([c]) => c === "start_drag");

  it("arrastar dentro da janela continua reordenando, sem arraste nativo", () => {
    useDocs.getState().add([info(1), info(2), info(3)]);
    render(<Sidebar />);
    fireEvent.pointerDown(item("1.png"), { button: 0, clientX: 50, clientY: 10 });
    moveTo(50, 300);
    act(() => void window.dispatchEvent(new MouseEvent("pointerup", { clientX: 50, clientY: 300 })));
    expect(useDocs.getState().docs.map((d) => d.id)).toEqual([2, 3, 1]);
    expect(startDragCalls()).toHaveLength(0);
  });

  it("sair da janela arrasta a seleção (Ctrl) para fora; o temporário só para quem tem alteração", () => {
    useDocs.getState().add([info(1), info(2, { dirty: true }), info(3)]);
    render(<Sidebar />);
    fireEvent.click(item("2.png"), { ctrlKey: true });
    expect(item("1.png").getAttribute("aria-pressed")).toBe("true");
    expect(item("3.png").getAttribute("aria-pressed")).toBe("false");
    fireEvent.pointerDown(item("2.png"), { button: 0, clientX: 50, clientY: 10 });
    moveTo(-3, 10);
    expect(startDragCalls()).toEqual([["start_drag", { items: [{ id: 1, export: false }, { id: 2, export: true }] }]]);
    // O arraste interno acabou: soltar depois não reordena.
    act(() => void window.dispatchEvent(new MouseEvent("pointerup", { clientX: -3, clientY: 10 })));
    expect(useDocs.getState().docs.map((d) => d.id)).toEqual([1, 2, 3]);
  });

  it("miniatura fora da seleção vai sozinha; Shift seleciona o intervalo", () => {
    useDocs.getState().add([info(1), info(2), info(3), info(4, { path: "" })]);
    render(<Sidebar />);
    fireEvent.click(item("3.png"), { shiftKey: true });
    expect(useDocs.getState().activeId).toBe(3);
    fireEvent.pointerDown(item("4.png"), { button: 0, clientX: 50, clientY: 10 });
    moveTo(50, window.innerHeight + 5);
    expect(startDragCalls()).toEqual([["start_drag", { items: [{ id: 4, export: true }] }]]);
    fireEvent.pointerDown(item("2.png"), { button: 0, clientX: 50, clientY: 10 });
    moveTo(window.innerWidth, 10);
    expect(startDragCalls()[1]).toEqual(["start_drag", { items: [1, 2, 3].map((id) => ({ id, export: false })) }]);
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
