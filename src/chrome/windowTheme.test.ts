import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WindowTheme } from "./windowTheme";

const base: WindowTheme = {
  layout: { left: [], right: ["minimize", "maximize", "close"] },
  style: "breeze",
  dark: false,
  accent: "#3daee9",
  icons: null,
  colors: null,
};

let current: WindowTheme = base;
let themeListener: ((e: { payload: WindowTheme }) => void) | undefined;
let resizeListener: (() => void) | undefined;
let maximized = false;
let compositing = true;
const win = {
  isMaximized: vi.fn(async () => maximized),
  onResized: vi.fn(async (cb: () => void) => {
    resizeListener = cb;
    return () => {};
  }),
  minimize: vi.fn(async () => {}),
  toggleMaximize: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  setDecorations: vi.fn(async () => {}),
  startResizeDragging: vi.fn(async () => {}),
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => (cmd === "compositing_available" ? compositing : current)),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_n: string, cb: (e: { payload: WindowTheme }) => void) => {
    themeListener = cb;
    return () => {};
  }),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));

const { TitleBar, WindowFrame } = await import("./TitleBar");
const { resetNativeDecorations } = await import("./nativeDecorations");

const buttons = (side: "left" | "right") =>
  Array.from(document.querySelectorAll(`[data-side="${side}"] [data-button]`)).map((b) =>
    b.getAttribute("data-button"),
  );

beforeEach(() => {
  localStorage.clear();
  resetNativeDecorations();
  compositing = true;
  current = base;
  maximized = false;
  themeListener = undefined;
  resizeListener = undefined;
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("barra de título", () => {
  it("renderiza botões na ordem do layout", async () => {
    current = { ...base, layout: { left: ["close", "minimize"], right: ["maximize"] } };
    render(createElement(TitleBar, { title: "foto.jpg" }));
    await waitFor(() => expect(buttons("left")).toEqual(["close", "minimize"]));
    expect(buttons("right")).toEqual(["maximize"]);
    expect(screen.getByText("foto.jpg")).toBeTruthy();
  });

  it("esconde botão ausente", async () => {
    current = { ...base, layout: { left: [], right: ["close"] } };
    render(createElement(TitleBar, { title: "x" }));
    await waitFor(() => expect(buttons("right")).toEqual(["close"]));
    expect(document.querySelector('[data-button="minimize"]')).toBeNull();
    expect(document.querySelector('[data-button="maximize"]')).toBeNull();
  });

  it("atualiza ao receber window-theme-changed", async () => {
    render(createElement(TitleBar, { title: "x" }));
    await waitFor(() => expect(buttons("right")).toEqual(["minimize", "maximize", "close"]));
    await waitFor(() => expect(themeListener).toBeDefined());
    act(() =>
      themeListener!({
        payload: { ...base, layout: { left: ["close", "minimize", "maximize"], right: [] }, style: "adwaita", dark: true },
      }),
    );
    await waitFor(() => expect(buttons("left")).toEqual(["close", "minimize", "maximize"]));
    expect(buttons("right")).toEqual([]);
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.querySelector(".window-buttons.style-adwaita")).not.toBeNull();
  });

  it("botão maximizar vira restaurar quando maximizado", async () => {
    render(createElement(TitleBar, { title: "x" }));
    await waitFor(() => expect(document.querySelector('[data-button="maximize"]')).not.toBeNull());
    expect(document.querySelector('[data-button="maximize"]')!.getAttribute("data-action")).toBe("maximize");
    maximized = true;
    await waitFor(() => expect(resizeListener).toBeDefined());
    await act(async () => resizeListener!());
    await waitFor(() =>
      expect(document.querySelector('[data-button="maximize"]')!.getAttribute("data-action")).toBe("restore"),
    );
  });

  it("decoração nativa esconde botões e liga a decoração do sistema", async () => {
    render(createElement(TitleBar, { title: "x", nativeDecorations: true }));
    await waitFor(() => expect(win.setDecorations).toHaveBeenCalledWith(true));
    expect(document.querySelector("[data-button]")).toBeNull();
  });

  it("não trata duplo clique no header (o Tauri já alterna pela região de arrasto)", async () => {
    render(createElement(TitleBar, { title: "x" }, createElement("button", { "data-testid": "tool" }, "T")));
    const header = document.querySelector("header.titlebar")!;
    await waitFor(() => expect(document.querySelector("[data-button]")).not.toBeNull());
    fireEvent.doubleClick(header);
    expect(win.toggleMaximize).not.toHaveBeenCalled();
  });

  it("filhos interativos ficam fora da região de arrasto", async () => {
    render(createElement(TitleBar, { title: "x" }, createElement("button", { "data-testid": "tool" }, "T")));
    const tool = screen.getByTestId("tool");
    expect(tool.hasAttribute("data-tauri-drag-region")).toBe(false);
    expect(tool.parentElement!.hasAttribute("data-tauri-drag-region")).toBe(false);
    expect(document.querySelector(".titlebar-title")!.hasAttribute("data-tauri-drag-region")).toBe(true);
    document.querySelectorAll(".window-buttons, .wb-btn").forEach((b) => expect(b.hasAttribute("data-tauri-drag-region")).toBe(false));
  });
});

describe("fallback para a decoração nativa", () => {
  it("startResizeDragging rejeitado liga o modo nativo, esconde botões e bordas e guarda a decisão", async () => {
    win.startResizeDragging.mockRejectedValueOnce(new Error("sem suporte"));
    render(createElement(WindowFrame, null, createElement(TitleBar, { title: "x" })));
    await waitFor(() => expect(document.querySelector("[data-button]")).not.toBeNull());
    fireEvent.mouseDown(document.querySelector(".edge-North")!, { button: 0 });
    await waitFor(() => expect(win.setDecorations).toHaveBeenCalledWith(true));
    await waitFor(() => expect(document.querySelector("[data-button]")).toBeNull());
    expect(document.querySelector(".resize-edge")).toBeNull();
    expect(localStorage.getItem("gvi.nativeDecorations")).toBe("1");
  });

  it("sem composição (transparência indisponível) cai na decoração nativa na inicialização", async () => {
    compositing = false;
    render(createElement(TitleBar, { title: "x" }));
    await waitFor(() => expect(win.setDecorations).toHaveBeenCalledWith(true));
    expect(document.querySelector("[data-button]")).toBeNull();
  });

  it("decisão guardada vale na próxima abertura", async () => {
    localStorage.setItem("gvi.nativeDecorations", "1");
    resetNativeDecorations();
    render(createElement(TitleBar, { title: "x" }));
    await waitFor(() => expect(win.setDecorations).toHaveBeenCalledWith(true));
    expect(document.querySelector("[data-button]")).toBeNull();
  });
});

describe("tema inicial", () => {
  it("usa prefers-color-scheme antes da resposta do backend", () => {
    window.matchMedia = ((q: string) => ({ matches: q.includes("dark") })) as typeof window.matchMedia;
    delete document.documentElement.dataset.theme;
    render(createElement(TitleBar, { title: "x" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
