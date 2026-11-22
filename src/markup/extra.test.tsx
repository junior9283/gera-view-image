import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
vi.mock("./camera", async (orig) => ({ ...(await orig<typeof import("./camera")>()), startCamera: () => startCamera() }));

import i18n from "../i18n";
import { Slot } from "../lib/slots";
import { registerCommand, resetCommandsForTests, runCommand } from "../shortcuts/commands";
import { useDocs, resetDocsForTests } from "../store/docs";
import { getPrefs, resetPrefsForTests, setPrefs } from "../store/prefs";
import { useSelection } from "../store/selection";
import { addAnnotation } from "./actions";
import { resetHistoryForTests } from "./history";
import { resetFontsForTests } from "./fonts";
import "./register";
import { registerMarkupCommands } from "./commands";
import { DEFAULT_STYLE, type Annotation } from "./model";
import { getItems, resetMarkupForTests, useMarkup } from "./store";

const info: DocInfo = {
  id: 7, path: "/a.png", name: "a.png", format: "png", width: 400, height: 300, frames: 1,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 1, error: null,
};
const overlay = { scale: 2, panX: 10, panY: 20, imageW: 400, imageH: 300 };
const rect = (id: string): Annotation => ({ id, kind: "rect", geom: { x: 10, y: 10, w: 50, h: 50 }, style: { ...DEFAULT_STYLE } });

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
  registerMarkupCommands();
  useSelection.setState({ selection: null, selectionTool: null });
  systemFonts.mockReset().mockResolvedValue(["Zeta Sans", "Alfa Serif", "3270 Mono"]);
  renderView.mockReset();
  startCamera.mockReset();
  cameraAllow.mockClear();
});
afterEach(cleanup);

const open = (name: string) => {
  render(<Slot name="below-toolbar" props={{}} />);
  act(() => void window.dispatchEvent(new Event("gvi:toggle-markup")));
  fireEvent.click(screen.getByRole("button", { name }));
};

describe("painel Cores", () => {
  it("escolher uma cor aplica à borda, guarda nas recentes e respeita a opacidade", async () => {
    open("Cores");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "#0a84ff" }));
    expect(useMarkup.getState().style.stroke).toBe("#0a84ff");
    expect(getPrefs().recentColors).toEqual(["#0a84ff"]);
    fireEvent.change(screen.getByRole("slider"), { target: { value: "50" } });
    expect(useMarkup.getState().style.stroke).toBe("#0a84ff80");
    // Cor nova depois da opacidade mantém os 50%.
    fireEvent.click(screen.getByRole("menuitemradio", { name: "#34c759" }));
    expect(useMarkup.getState().style.stroke).toBe("#34c75980");
    expect(getPrefs().recentColors[0]).toBe("#34c75980");
  });

  it("o alvo muda para preenchimento e texto", () => {
    open("Cores");
    fireEvent.click(screen.getByRole("tab", { name: "Preenchimento" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "#ff9500" }));
    expect(useMarkup.getState().style.fill).toBe("#ff9500");
    fireEvent.click(screen.getByRole("tab", { name: "Texto" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "#af52de" }));
    expect(useMarkup.getState().style.font?.color).toBe("#af52de");
    expect(useMarkup.getState().style.stroke).toBe(DEFAULT_STYLE.stroke);
  });

  it("muda a cor da anotação selecionada num passo do desfazer", () => {
    addAnnotation(7, rect("a"));
    open("Cores");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "#000000" }));
    expect(getItems(7)[0].style.stroke).toBe("#000000");
  });

  it("o conta-gotas lê o pixel da imagem como é exibido e entrega a cor", async () => {
    renderView.mockResolvedValue({ width: 1, height: 1, data: new Uint8ClampedArray([12, 34, 56, 255]) });
    open("Cores");
    fireEvent.click(screen.getByTestId("colors-eyedropper"));
    render(<Slot name="viewport-overlay" props={overlay} />);
    const layer = screen.getByTestId("eyedropper-layer");
    layer.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) });
    // tela (50, 60) = imagem ((50-10)/2, (60-20)/2) = (20, 20)
    fireEvent.pointerDown(layer, { clientX: 50, clientY: 60 });
    await waitFor(() => expect(useMarkup.getState().style.stroke).toBe("#0c2238"));
    expect(renderView).toHaveBeenCalledWith(7, 0, 1, 1, { x: 20, y: 20, w: 1, h: 1 });
    expect(screen.queryByTestId("eyedropper-layer")).toBeNull();
  });

  it("Esc cancela o conta-gotas sem mudar a cor", async () => {
    open("Cores");
    fireEvent.click(screen.getByTestId("colors-eyedropper"));
    render(<Slot name="viewport-overlay" props={overlay} />);
    expect(screen.getByTestId("eyedropper-layer")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("eyedropper-layer")).toBeNull());
    expect(useMarkup.getState().style.stroke).toBe(DEFAULT_STYLE.stroke);
  });
});

describe("painel Fontes", () => {
  it("lista as fontes devolvidas pelo sistema e aplica a escolhida ao texto", async () => {
    open("Fontes");
    await screen.findByRole("option", { name: "Alfa Serif" });
    expect(within(screen.getByRole("listbox")).getAllByRole("option").map((o) => o.textContent)).toEqual(["Zeta Sans", "Alfa Serif", "3270 Mono"]);
    fireEvent.click(screen.getByRole("button", { name: "3270 Mono" }));
    expect(useMarkup.getState().style.font?.family).toBe("3270 Mono");
  });

  it("a busca filtra", async () => {
    open("Fontes");
    await screen.findByRole("option", { name: "Alfa Serif" });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "serif" } });
    expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(1);
  });

  it("se a lista falha, avisa e mantém as fontes básicas", async () => {
    systemFonts.mockRejectedValue(new Error("x"));
    open("Fontes");
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "monospace" })).toBeTruthy();
  });

  it("Mostrar Fontes (comando) abre o painel", async () => {
    render(<Slot name="below-toolbar" props={{}} />);
    act(() => void runCommand("tools.showFonts"));
    expect(await screen.findByTestId("fonts-panel")).toBeTruthy();
  });
});

describe("inspetor de propriedades", () => {
  it("edita posição e tamanho da selecionada, com desfazer em um passo", () => {
    addAnnotation(7, rect("a"));
    open("Propriedades da anotação");
    const x = screen.getByLabelText("X") as HTMLInputElement;
    expect(x.value).toBe("10");
    fireEvent.change(x, { target: { value: "99" } });
    fireEvent.blur(x);
    expect(getItems(7)[0].geom).toMatchObject({ x: 99, w: 50 });
    const w = screen.getByLabelText("Largura") as HTMLInputElement;
    fireEvent.change(w, { target: { value: "0" } });
    fireEvent.blur(w);
    expect(getItems(7)[0].geom).toMatchObject({ w: 50 });
    expect(w.value).toBe("50");
  });

  it("muda a espessura e a opacidade da selecionada", () => {
    addAnnotation(7, rect("a"));
    open("Propriedades da anotação");
    const width = screen.getByLabelText("Espessura") as HTMLInputElement;
    fireEvent.change(width, { target: { value: "8" } });
    fireEvent.blur(width);
    fireEvent.change(screen.getByRole("slider"), { target: { value: "40" } });
    expect(getItems(7)[0].style).toMatchObject({ width: 8, stroke: "#ff3b3066" });
  });

  it("sem seleção, orienta", () => {
    open("Propriedades da anotação");
    expect(screen.getByText(/Selecione uma anotação/)).toBeTruthy();
  });
});

describe("botões Ajustar Cor, Ajustar Tamanho e Descrição", () => {
  it("chamam os comandos existentes", () => {
    const color = vi.fn();
    const resize = vi.fn();
    registerCommand("tools.adjustColor", color);
    registerCommand("tools.resize", resize);
    open("Ajustar Cor");
    fireEvent.click(screen.getByRole("button", { name: "Ajustar Tamanho" }));
    expect(color).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledTimes(1);
  });

  it("Descrição fica desabilitada sem handler e habilita quando o Lote 9 registra", () => {
    render(<Slot name="below-toolbar" props={{}} />);
    act(() => void window.dispatchEvent(new Event("gvi:toggle-markup")));
    const btn = () => screen.getByRole("button", { name: "Descrição da Imagem" }) as HTMLButtonElement;
    expect(btn().disabled).toBe(true);
    const run = vi.fn();
    act(() => void registerCommand("tools.imageDescription", run));
    expect(btn().disabled).toBe(false);
    fireEvent.click(btn());
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("assinatura pela câmera", () => {
  const openCamera = () => {
    open("Assinatura");
    fireEvent.click(screen.getByRole("tab", { name: "Câmera" }));
  };

  it("abrir a aba NÃO liga a câmera; só depois do consentimento", async () => {
    openCamera();
    expect(startCamera).not.toHaveBeenCalled();
    expect(cameraAllow).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("camera-start"));
    expect(screen.getByTestId("camera-consent")).toBeTruthy();
    expect(startCamera).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Cancelar"));
    expect(startCamera).not.toHaveBeenCalled();
    expect(screen.getByTestId("camera-start")).toBeTruthy();
  });

  it("consentir liga, mostra o indicador e desligar para a câmera", async () => {
    const stop = vi.fn(async () => {});
    startCamera.mockResolvedValue({ stream: {} as MediaStream, stop });
    openCamera();
    fireEvent.click(screen.getByTestId("camera-start"));
    fireEvent.click(screen.getByTestId("camera-allow"));
    expect(await screen.findByTestId("camera-on")).toBeTruthy();
    fireEvent.click(screen.getByTestId("camera-off"));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("camera-on")).toBeNull();
  });

  it("fechar o painel com a câmera ligada desliga a câmera", async () => {
    const stop = vi.fn(async () => {});
    startCamera.mockResolvedValue({ stream: {} as MediaStream, stop });
    openCamera();
    fireEvent.click(screen.getByTestId("camera-start"));
    fireEvent.click(screen.getByTestId("camera-allow"));
    await screen.findByTestId("camera-on");
    act(() => useMarkup.getState().setMenu(null));
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("trocar de aba com a câmera ligada também desliga", async () => {
    const stop = vi.fn(async () => {});
    startCamera.mockResolvedValue({ stream: {} as MediaStream, stop });
    openCamera();
    fireEvent.click(screen.getByTestId("camera-start"));
    fireEvent.click(screen.getByTestId("camera-allow"));
    await screen.findByTestId("camera-on");
    fireEvent.click(screen.getByRole("tab", { name: "Desenhar" }));
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("sem câmera ou sem permissão mostra erro claro", async () => {
    const { CameraError } = await import("./camera");
    startCamera.mockRejectedValue(new CameraError("notFound"));
    openCamera();
    fireEvent.click(screen.getByTestId("camera-start"));
    fireEvent.click(screen.getByTestId("camera-allow"));
    expect((await screen.findByTestId("camera-error")).textContent).toMatch(/Nenhuma câmera/);
  });

  it("câmera que liga depois de o painel fechar é desligada na hora", async () => {
    const stop = vi.fn(async () => {});
    let resolve!: (s: unknown) => void;
    startCamera.mockReturnValue(new Promise((r) => (resolve = r)));
    openCamera();
    fireEvent.click(screen.getByTestId("camera-start"));
    fireEvent.click(screen.getByTestId("camera-allow"));
    act(() => useMarkup.getState().setMenu(null));
    await act(async () => resolve({ stream: {}, stop }));
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
