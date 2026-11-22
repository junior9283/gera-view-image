// L20: alternativa textual da imagem, menus e diálogos com nome e teclado.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo } from "./ipc/types";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
const win = {
  label: "main", minimize: vi.fn(async () => {}), close: vi.fn(async () => {}), toggleMaximize: vi.fn(async () => {}),
  isMaximized: async () => false, onResized: async () => () => {}, setDecorations: async () => {}, setFullscreen: async () => {},
};
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./updater/updater", () => ({ checkForUpdate: async () => null, RELEASES_URL: "" }));

import { TitleBar } from "./chrome/TitleBar";
import { resetTextEditsForTests, setText } from "./inspector/textEdits";
import { LiveTextMenu } from "./livetext/LiveTextMenu";
import { resetDocsForTests, useDocs } from "./store/docs";
import { resetPrefsForTests, setPrefs } from "./store/prefs";
import { resetUiForTests, useUi } from "./store/ui";
import { CHECK_UPDATES_EVENT, UpdateHost } from "./updater/UpdateDialog";
import { Slideshow } from "./viewer/Slideshow";
import { Viewport } from "./viewer/Viewport";

const info = (id: number, extra: Partial<DocInfo> = {}): DocInfo => ({
  id, path: `/p/${id}.png`, name: "Praia à tarde.jpg", format: "jpeg", width: 400, height: 300, frames: 1,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 0, error: null, ...extra,
});
let texts: Record<string, string | null> = {};

beforeAll(() => {
  class RO {
    observe() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", RO);
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement["getContext"];
});

beforeEach(() => {
  texts = { title: null, description: null, author: null, altText: null };
  vi.clearAllMocks();
  invoke.mockImplementation(async (cmd: string) =>
    cmd === "window_theme" ? Promise.reject(new Error("sem tema")) : cmd === "metadata" ? { texts, keywords: [] } : cmd === "render_view" ? new Uint8Array([1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 255]).buffer : undefined,
  );
  resetDocsForTests();
  resetUiForTests();
  resetTextEditsForTests();
  resetPrefsForTests();
  setPrefs({ language: "pt-BR" });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const settle = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe("imagem com alternativa textual", () => {
  beforeEach(() => void vi.useFakeTimers());

  it("o nome do arquivo vale desde já; o texto alternativo entra depois de lido", async () => {
    texts.altText = "Duas cadeiras na areia";
    texts.description = "Férias";
    useDocs.getState().add([info(1)]);
    render(<Viewport />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe("Praia à tarde.jpg");
    await settle(1000);
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe("Praia à tarde.jpg: Duas cadeiras na areia");
    act(() => setText(1, "altText", "Pôr do sol"));
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe("Praia à tarde.jpg: Pôr do sol");
  });

  it("sem texto alternativo vale a descrição", async () => {
    texts.description = "Férias em família";
    useDocs.getState().add([info(1)]);
    render(<Viewport />);
    await settle(1000);
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe("Praia à tarde.jpg: Férias em família");
  });

  it("passar rápido pelas imagens não lê os metadados de cada uma", async () => {
    useDocs.getState().add([info(1), info(2, { name: "b.png" })]);
    render(<Viewport />);
    await settle(100);
    act(() => useDocs.getState().setActive(2));
    await settle(1000);
    expect(invoke.mock.calls.filter(([c]) => c === "metadata").map(([, a]) => (a as { id: number }).id)).toEqual([2]);
  });

  it("sem imagem (ou com erro) não há imagem para o leitor de tela; a área tem papel e nome", () => {
    render(<Viewport />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByRole("region", { name: "Visualização da imagem" })).toBeTruthy();
    act(() => useDocs.getState().add([info(1, { error: "corrupt" })]));
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("apresentação: diálogo modal com o foco nele e a imagem com nome", () => {
    useDocs.getState().add([info(1)]);
    useUi.setState({ slideshow: true });
    render(<Slideshow />);
    const dlg = screen.getByRole("dialog", { name: "Apresentação" });
    expect(document.activeElement).toBe(dlg);
    expect(screen.getByRole("img", { name: "Praia à tarde.jpg" })).toBeTruthy();
  });
});

describe("menus", () => {
  it("menu de contexto da barra de título: nome, foco, setas, Enter e Esc", () => {
    const { container } = render(<TitleBar title="x" />);
    fireEvent.contextMenu(container.querySelector("header")!, { clientX: 10, clientY: 10 });
    expect(screen.getByRole("menu", { name: "Menu da janela" })).toBeTruthy();
    expect(document.activeElement?.textContent).toBe("Minimizar");
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement?.textContent).toBe("Fechar");
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(win.close).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.contextMenu(container.querySelector("header")!, { clientX: 10, clientY: 10 });
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("menu do Texto ao Vivo: nome e setas com volta", () => {
    render(<LiveTextMenu at={{ x: 0, y: 0 }} onClose={() => {}} />);
    expect(screen.getByRole("menu", { name: "Texto selecionado" })).toBeTruthy();
    expect(document.activeElement?.textContent).toBe("Copiar");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    const items = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(items[items.length - 1]);
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(items[items.length - 1]);
  });
});

it("o aviso de atualização em dia tem nome acessível", async () => {
  render(<UpdateHost />);
  await act(async () => void window.dispatchEvent(new Event(CHECK_UPDATES_EVENT)));
  expect(screen.getByRole("dialog").getAttribute("aria-labelledby")).toBeTruthy();
  expect(screen.getByRole("dialog", { name: "Você já está na versão mais recente." })).toBeTruthy();
});
