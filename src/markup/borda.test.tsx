// Revisão do Lote 10: blur ao fechar, um passo de desfazer por arrasto, opacidade do texto,
// página do conta-gotas e casos de borda da câmera.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo } from "../ipc/types";

const systemFonts = vi.fn();
const renderView = vi.fn();
const cameraAllow = vi.fn<(allowed: boolean) => Promise<void>>(async () => {});
vi.mock("../ipc/commands", () => ({
  applyOp: vi.fn(),
  undo: vi.fn(),
  redo: vi.fn(),
  instantAlpha: vi.fn(),
  renderView: (...a: unknown[]) => renderView(...a),
  systemFonts: () => systemFonts(),
  cameraAllow: (a: boolean) => cameraAllow(a),
}));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn(async () => { throw new Error("sem store"); }) }));
const startCamera = vi.fn();
vi.mock("./camera", async (orig) => ({ ...(await orig<typeof import("./camera")>()), startCamera: (cb?: () => void) => startCamera(cb) }));
const addSignature = vi.fn();
vi.mock("./signatures", async (orig) => ({ ...(await orig<typeof import("./signatures")>()), addSignature: (p: string) => addSignature(p) }));

import i18n from "../i18n";
import { Slot } from "../lib/slots";
import { resetCommandsForTests } from "../shortcuts/commands";
import { useDocs, resetDocsForTests } from "../store/docs";
import { getPrefs, resetPrefsForTests, setPrefs } from "../store/prefs";
import { useSelection } from "../store/selection";
import { resetUiForTests, useUi } from "../store/ui";
import { addAnnotation } from "./actions";
import { registerMarkupCommands } from "./commands";
import { resetFontsForTests } from "./fonts";
import { resetHistoryForTests, undo } from "./history";
import "./register";
import { DEFAULT_FONT, DEFAULT_STYLE, type Annotation } from "./model";
import { getItems, resetMarkupForTests, useMarkup } from "./store";

const info: DocInfo = {
  id: 7, path: "/a.png", name: "a.png", format: "png", width: 400, height: 300, frames: 1,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 1, error: null,
};
const overlay = { scale: 2, panX: 10, panY: 20, imageW: 400, imageH: 300 };
const rect = (id: string): Annotation => ({ id, kind: "rect", geom: { x: 10, y: 10, w: 50, h: 50 }, style: { ...DEFAULT_STYLE } });
const text = (): Annotation => ({ id: "t", kind: "text", geom: { x: 0, y: 0, w: 80, h: 20, text: "a" }, style: { ...DEFAULT_STYLE, font: { ...DEFAULT_FONT, color: "#000000" } } });

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;
});
beforeEach(async () => {
  resetPrefsForTests();
  setPrefs({ language: "pt-BR" });
  await i18n.changeLanguage("pt-BR");
  resetDocsForTests();
  useDocs.getState().add([info]);
  resetMarkupForTests();
  resetHistoryForTests();
  resetFontsForTests();
  resetCommandsForTests();
  resetUiForTests();
  registerMarkupCommands();
  useSelection.setState({ selection: null, selectionTool: null });
  systemFonts.mockReset().mockResolvedValue(["Zeta Sans", "Alfa Serif"]);
  renderView.mockReset();
  startCamera.mockReset();
  addSignature.mockReset();
  cameraAllow.mockClear();
});
afterEach(cleanup);

const open = (name: string) => {
  render(<Slot name="below-toolbar" props={{}} />);
  act(() => void window.dispatchEvent(new Event("gvi:toggle-markup")));
  fireEvent.click(screen.getByRole("button", { name }));
};
const outside = () => fireEvent.pointerDown(document.body);

describe("fechar o painel clicando fora grava o que estava sendo digitado", () => {
  it("valor numérico do inspetor", () => {
    addAnnotation(7, rect("a"));
    open("Propriedades da anotação");
    const x = screen.getByLabelText("X") as HTMLInputElement;
    x.focus();
    fireEvent.change(x, { target: { value: "77" } });
    outside();
    expect(screen.queryByTestId("props-panel")).toBeNull();
    expect(getItems(7)[0].geom).toMatchObject({ x: 77 });
  });

  it("texto da anotação", () => {
    addAnnotation(7, text());
    open("Propriedades da anotação");
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    box.focus();
    fireEvent.change(box, { target: { value: "novo texto" } });
    outside();
    expect((getItems(7)[0].geom as { text: string }).text).toBe("novo texto");
  });

  it("cor personalizada vai para as recentes", () => {
    open("Cores");
    const c = document.querySelector('input[type="color"]') as HTMLInputElement;
    c.focus();
    fireEvent.change(c, { target: { value: "#123456" } });
    outside();
    expect(getPrefs().recentColors).toEqual(["#123456"]);
  });
});

describe("arrastar slider ou cor é um passo só do desfazer", () => {
  const drag = (el: HTMLElement, values: string[]) => {
    values.forEach((v) => fireEvent.change(el, { target: { value: v } }));
    fireEvent.pointerUp(el);
  };

  it("opacidade do inspetor", async () => {
    addAnnotation(7, rect("a"));
    open("Propriedades da anotação");
    drag(screen.getByRole("slider"), ["90", "60", "30"]);
    expect(getItems(7)[0].style.stroke).toBe("#ff3b304d");
    await undo(7);
    expect(getItems(7)[0].style.stroke).toBe("#ff3b30");
  });

  it("opacidade do painel Cores", async () => {
    addAnnotation(7, rect("a"));
    open("Cores");
    drag(screen.getByRole("slider"), ["80", "50", "20"]);
    expect(getItems(7)[0].style.stroke).toBe("#ff3b3033");
    await undo(7);
    expect(getItems(7)[0].style.stroke).toBe("#ff3b30");
  });

  it("cor personalizada do painel Cores", async () => {
    addAnnotation(7, rect("a"));
    open("Cores");
    const c = document.querySelector('input[type="color"]') as HTMLInputElement;
    c.focus();
    ["#111111", "#222222", "#333333"].forEach((v) => fireEvent.change(c, { target: { value: v } }));
    fireEvent.blur(c);
    expect(getItems(7)[0].style.stroke).toBe("#333333");
    await undo(7);
    expect(getItems(7)[0].style.stroke).toBe("#ff3b30");
  });
});

describe("opacidade no inspetor", () => {
  it("em texto vale para a cor da fonte", () => {
    addAnnotation(7, text());
    open("Propriedades da anotação");
    const s = screen.getByRole("slider");
    fireEvent.change(s, { target: { value: "50" } });
    fireEvent.pointerUp(s);
    const st = getItems(7)[0].style;
    expect(st.font?.color).toBe("#00000080");
    expect(st.stroke).toBe(DEFAULT_STYLE.stroke);
  });

  it.each(["signature", "image"] as const)("não aparece em %s", (kind) => {
    addAnnotation(7, { id: kind, kind, geom: { x: 0, y: 0, w: 10, h: 10, src: "data:image/png;base64,AA" }, style: { ...DEFAULT_STYLE } });
    open("Propriedades da anotação");
    expect(screen.getByTestId("props-panel")).toBeTruthy();
    expect(screen.queryByRole("slider")).toBeNull();
  });

  it("não aparece em realce", () => {
    addAnnotation(7, { id: "h", kind: "highlight", geom: { x: 0, y: 0, w: 10, h: 10, shape: "rect" }, style: { ...DEFAULT_STYLE } });
    open("Propriedades da anotação");
    expect(screen.getByTestId("props-panel")).toBeTruthy();
    expect(screen.queryByRole("slider")).toBeNull();
  });
});

describe("conta-gotas e a página exibida", () => {
  it("lê a página escolhida na barra lateral", async () => {
    useUi.getState().setPage(3);
    renderView.mockResolvedValue({ width: 1, height: 1, data: new Uint8ClampedArray([1, 2, 3, 255]) });
    open("Cores");
    fireEvent.click(screen.getByTestId("colors-eyedropper"));
    render(<Slot name="viewport-overlay" props={overlay} />);
    const layer = screen.getByTestId("eyedropper-layer");
    layer.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(layer, { clientX: 50, clientY: 60 });
    await waitFor(() => expect(renderView).toHaveBeenCalled());
    expect(renderView.mock.calls[0][1]).toBe(3);
  });
});

describe("câmera: casos de borda", () => {
  const openCamera = () => {
    open("Assinatura");
    fireEvent.click(screen.getByRole("tab", { name: "Câmera" }));
    fireEvent.click(screen.getByTestId("camera-start"));
    fireEvent.click(screen.getByTestId("camera-allow"));
  };

  it("fechar o painel enquanto liga desarma o consentimento", () => {
    startCamera.mockReturnValue(new Promise(() => {}));
    openCamera();
    cameraAllow.mockClear();
    act(() => useMarkup.getState().setMenu(null));
    expect(cameraAllow).toHaveBeenCalledWith(false);
  });

  it("câmera que liga com a janela escondida é desligada na hora", async () => {
    const stop = vi.fn(async () => {});
    let resolve!: (s: unknown) => void;
    startCamera.mockReturnValue(new Promise((r) => (resolve = r)));
    openCamera();
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    try {
      await act(async () => resolve({ stream: {}, stop }));
      expect(stop).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId("camera-on")).toBeNull();
    } finally {
      Object.defineProperty(document, "hidden", { value: false, configurable: true });
    }
  });

  it("webcam desconectada com a câmera ligada vira erro e desliga", async () => {
    const stop = vi.fn(async () => {});
    let ended!: () => void;
    startCamera.mockImplementation(async (cb: () => void) => {
      ended = cb;
      return { stream: {} as MediaStream, stop };
    });
    openCamera();
    await screen.findByTestId("camera-on");
    act(() => ended());
    expect(stop).toHaveBeenCalledTimes(1);
    expect((await screen.findByTestId("camera-error")).textContent).toMatch(/desconectada/);
  });

  it("falha ao salvar a assinatura avisa", async () => {
    const stop = vi.fn(async () => {});
    startCamera.mockResolvedValue({ stream: {} as MediaStream, stop });
    addSignature.mockRejectedValue(new Error("disco"));
    const cam = await import("./camera");
    vi.spyOn(cam, "grabFrame").mockReturnValue({ data: new Uint8ClampedArray(16), width: 2, height: 2 });
    vi.spyOn(cam, "frameToSignature").mockReturnValue("QUJD");
    openCamera();
    await screen.findByTestId("camera-on");
    fireEvent.click(screen.getByTestId("camera-capture"));
    fireEvent.click(await screen.findByTestId("camera-save"));
    expect(await screen.findByTestId("camera-save-error")).toBeTruthy();
  });
});

describe("painel Fontes", () => {
  it("mostra as genéricas junto da lista do sistema", async () => {
    open("Fontes");
    await screen.findByRole("option", { name: "Alfa Serif" });
    expect(screen.getByRole("button", { name: "monospace" })).toBeTruthy();
  });
});
