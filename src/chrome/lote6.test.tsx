// Lote 6: barra personalizável, Ocultar Barra, Compartilhar (e-mail, KDE Connect, Abrir com) e Ajuda › Pesquisar.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  shareEmail: vi.fn(),
  shareDevice: vi.fn(),
  shareDevices: vi.fn(),
  shareDeviceAvailable: vi.fn(() => Promise.resolve(false)),
  openWithApps: vi.fn(),
  openWithApp: vi.fn(),
}));
vi.mock("../ipc/commands", () => ipc);

import type { DocInfo } from "../ipc/types";
import { Slot } from "../lib/slots";
import { isEnabled, registerCommand, runCommand } from "../shortcuts/commands";
import { useDocs } from "../store/docs";
import { getPrefs, resetPrefsForTests, setPrefs } from "../store/prefs";
import { useThumbSelection } from "../sidebar/selection";
import { resetUiForTests, useUi } from "../store/ui";
import { getToasts, resetToastsForTests } from "./notify";
import { MenuBar } from "./MenuBar";
import { resetShareForTests } from "./share";
import { Toolbar } from "./Toolbar";
import { insertIndex, moveItem, resolveToolbar } from "./toolbarItems";
import "./register";

const info: DocInfo = {
  id: 7, path: "/x/a.png", name: "a.png", format: "png", width: 32, height: 24, frames: 1,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 0, error: null,
};

beforeEach(() => {
  for (const f of Object.values(ipc)) f.mockReset().mockResolvedValue(undefined);
  ipc.openWithApps.mockResolvedValue([]);
  resetPrefsForTests();
  setPrefs({ language: "pt-BR" });
  resetToastsForTests();
  resetShareForTests(false);
  useDocs.setState({ docs: [info], activeId: 7 });
});
afterEach(cleanup);

const toolbarButtons = () => within(screen.getByRole("toolbar")).getAllByRole("button").map((b) => b.getAttribute("aria-label"));

describe("itens da barra", () => {
  it("resolve a preferência: padrão, sem desconhecidos nem repetidos", () => {
    expect(resolveToolbar(null)).toEqual(["sidebar", "zoom", "share", "markup", "rotate", "inspector"]);
    expect(resolveToolbar(["crop", "xyz", "crop", "share"])).toEqual(["crop", "share"]);
  });

  it("move e calcula a posição de inserção", () => {
    expect(moveItem(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
    expect(moveItem(["a", "b"], "x", 0)).toEqual(["x", "a", "b"]);
    expect(moveItem(["a", "b"], "x", 99)).toEqual(["a", "b", "x"]);
    const rects = [{ left: 0, width: 40 }, { left: 50, width: 40 }];
    expect([insertIndex(rects, 5), insertIndex(rects, 30), insertIndex(rects, 80), insertIndex(rects, 200)]).toEqual([0, 1, 2, 2]);
  });
});

describe("Toolbar", () => {
  it("segue a ordem e o modo da preferência; Ocultar Barra (Ctrl+Shift+T) a esconde", () => {
    setPrefs({ toolbarItems: ["crop", "share"], toolbarMode: "text" });
    render(<Toolbar />);
    expect(toolbarButtons()).toEqual(["Recortar", "Compartilhar"]);
    expect(screen.getByRole("toolbar").textContent).toContain("Recortar");
    act(() => void runCommand("view.toolbar"));
    expect(getPrefs().toolbarHidden).toBe(true);
    expect(screen.queryByRole("toolbar")).toBeNull();
    act(() => void runCommand("view.toolbar"));
    expect(screen.getByRole("toolbar")).toBeTruthy();
  });

  it("Compartilhar: e-mail, copiar, exportar e Abrir com ▸ com os apps do tipo", async () => {
    ipc.openWithApps.mockResolvedValue([{ id: "org.gimp.GIMP.desktop", name: "GIMP", icon: null }]);
    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "Compartilhar" }));
    expect(screen.queryByRole("menuitem", { name: /KDE Connect/ })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: /E-mail/ }));
    expect(ipc.shareEmail).toHaveBeenCalledWith([7]);

    fireEvent.click(screen.getByRole("button", { name: "Compartilhar" }));
    await waitFor(() => expect(ipc.openWithApps).toHaveBeenCalledWith(7));
    const openWith = screen.getByRole("menuitem", { name: /Abrir com/ });
    await waitFor(() => expect(openWith.getAttribute("aria-disabled")).toBe("false"));
    fireEvent.mouseEnter(openWith);
    fireEvent.click(await screen.findByRole("menuitem", { name: "GIMP" }));
    expect(ipc.openWithApp).toHaveBeenCalledWith(7, "org.gimp.GIMP.desktop");
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("KDE Connect", () => {
  it("aparece só com o kdeconnect-cli; um aparelho envia direto", async () => {
    resetShareForTests(true);
    ipc.shareDevices.mockResolvedValue([{ id: "p7", name: "Pixel 7" }]);
    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "Compartilhar" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /KDE Connect/ }));
    await waitFor(() => expect(ipc.shareDevice).toHaveBeenCalledWith([7], "p7"));
    await waitFor(() => expect(getToasts().map((t) => t.text)).toContain("Enviado para Pixel 7."));
  });

  it("vários aparelhos: pergunta qual; nenhum: avisa", async () => {
    resetShareForTests(true);
    ipc.shareDevices.mockResolvedValue([{ id: "a", name: "Celular" }, { id: "b", name: "Tablet" }]);
    render(<Slot name="below-toolbar" props={{}} />);
    await act(async () => void runCommand("file.shareDevice"));
    fireEvent.click(await screen.findByRole("button", { name: "Tablet" }));
    await waitFor(() => expect(ipc.shareDevice).toHaveBeenCalledWith([7], "b"));
    expect(screen.queryByRole("dialog")).toBeNull();

    ipc.shareDevices.mockResolvedValue([]);
    await act(async () => void runCommand("file.shareDevice"));
    await waitFor(() => expect(getToasts().map((t) => t.text)).toContain("Nenhum aparelho do KDE Connect disponível."));
  });

  it("sem arquivo em disco, compartilhar fica desabilitado", () => {
    resetShareForTests(true);
    useDocs.setState({ docs: [{ ...info, path: "" }], activeId: 7 });
    expect(isEnabled("file.shareEmail")).toBe(false);
    expect(isEnabled("file.shareDevice")).toBe(false);
  });
});

describe("compartilhar a seleção da barra lateral", () => {
  const docs = [7, 8, 9].map((id) => ({ ...info, id, name: `${id}.png`, path: id === 9 ? "" : `/x/${id}.png` }));
  beforeEach(() => {
    useDocs.setState({ docs, activeId: 8 });
    useUi.setState({ sidebar: "thumbs", slideshow: false });
    useThumbSelection.setState({ picked: [7, 8], anchor: 7 });
  });
  afterEach(() => {
    resetUiForTests();
    useThumbSelection.setState({ picked: [], anchor: null });
  });

  it("e-mail e KDE Connect levam todas as selecionadas", async () => {
    runCommand("file.shareEmail");
    expect(ipc.shareEmail).toHaveBeenCalledWith([7, 8]);
    resetShareForTests(true);
    ipc.shareDevices.mockResolvedValue([{ id: "p7", name: "Pixel 7" }]);
    runCommand("file.shareDevice");
    await waitFor(() => expect(ipc.shareDevice).toHaveBeenCalledWith([7, 8], "p7"));
  });

  it("as sem arquivo em disco ficam de fora, com aviso", () => {
    useThumbSelection.setState({ picked: [7, 8, 9], anchor: 7 });
    runCommand("file.shareEmail");
    expect(ipc.shareEmail).toHaveBeenCalledWith([7, 8]);
    expect(getToasts().map((t) => t.text)).toEqual(["Sem arquivo em disco, não enviadas: 9.png."]);
  });

  it("habilita se alguma selecionada tem arquivo, mesmo que a ativa não tenha", () => {
    useDocs.setState({ activeId: 9 });
    expect(isEnabled("file.shareEmail")).toBe(false);
    useThumbSelection.setState({ picked: [7, 9], anchor: 7 });
    expect(isEnabled("file.shareEmail")).toBe(true);
  });
});

describe("Personalizar Barra de Ferramentas", () => {
  const open = () => {
    render(<Slot name="below-toolbar" props={{}} />);
    act(() => void runCommand("view.customizeToolbar"));
    return screen.getByRole("dialog");
  };
  const bar = () => within(screen.getByRole("list", { name: "Barra de ferramentas" }));
  const palette = () => within(screen.getByRole("list", { name: "Itens disponíveis" }));

  it("clique na paleta acrescenta; Delete tira; Ctrl+← move; padrão restaura; persiste nas prefs", () => {
    open();
    fireEvent.click(palette().getByRole("button", { name: /Recortar/ }));
    expect(getPrefs().toolbarItems).toEqual(["sidebar", "zoom", "share", "markup", "rotate", "inspector", "crop"]);
    expect(palette().queryByRole("button", { name: /Recortar/ })).toBeNull();
    fireEvent.keyDown(bar().getByRole("button", { name: /Recortar/ }), { key: "ArrowLeft", ctrlKey: true });
    expect(getPrefs().toolbarItems?.slice(-2)).toEqual(["crop", "inspector"]);
    fireEvent.keyDown(bar().getByRole("button", { name: /Barra Lateral/ }), { key: "Delete" });
    expect(getPrefs().toolbarItems?.[0]).toBe("zoom");
    fireEvent.click(screen.getByRole("button", { name: "Restaurar o conjunto padrão" }));
    expect(getPrefs().toolbarItems).toBeNull();
  });

  it("Mostrar muda o modo; OK fecha", () => {
    open();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "iconText" } });
    expect(getPrefs().toolbarMode).toBe("iconText");
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("arrastar da paleta para a barra insere na posição; arrastar para fora tira", () => {
    setPrefs({ toolbarItems: ["sidebar", "share"] });
    open();
    // Barra em y 0–60; cada item tem 50 px de largura a partir de x 0.
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const id = this.dataset.toolId;
      const i = id ? ["sidebar", "share"].indexOf(id) : -1;
      if (i >= 0) return { left: i * 50, right: i * 50 + 50, width: 50, top: 5, bottom: 55, height: 50 } as DOMRect;
      if (this.classList.contains("customize-bar")) return { left: 0, right: 500, width: 500, top: 0, bottom: 60, height: 60 } as DOMRect;
      return { left: 0, right: 0, width: 0, top: 0, bottom: 0, height: 0 } as DOMRect;
    });
    const drag = (el: HTMLElement, x: number, y: number) => {
      fireEvent.pointerDown(el, { clientX: 300, clientY: 300, button: 0 });
      fireEvent.pointerMove(window, { clientX: x, clientY: y });
      fireEvent.pointerUp(window, { clientX: x, clientY: y });
    };
    drag(palette().getByRole("button", { name: /Recortar/ }), 40, 30);
    expect(getPrefs().toolbarItems).toEqual(["sidebar", "crop", "share"]);
    drag(bar().getByRole("button", { name: /Barra Lateral/ }), 40, 400);
    expect(getPrefs().toolbarItems).toEqual(["crop", "share"]);
    rect.mockRestore();
  });
});

describe("Ajuda › Pesquisar", () => {
  it("Ctrl+? abre o menu Ajuda com o foco no campo; digitar lista itens; Enter executa", () => {
    const zoom = vi.fn();
    registerCommand("view.zoomIn", zoom);
    render(<MenuBar />);
    act(() => void runCommand("help.search"));
    const field = screen.getByRole("searchbox", { name: "Pesquisar…" });
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: "ampli" } });
    const hit = screen.getAllByRole("menuitem", { name: /Ampliar/ })[0];
    expect(hit.textContent).toMatch(/^Ampliar/);
    expect(hit.textContent).toContain("Visualizar");
    fireEvent.keyDown(field, { key: " " });
    expect(screen.getByRole("searchbox")).toBeTruthy();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(zoom).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("sem resultado avisa; Esc limpa e depois fecha; seta para baixo vai aos itens", () => {
    render(<MenuBar />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Ajuda" }));
    const field = screen.getByRole("searchbox");
    fireEvent.change(field, { target: { value: "zzzz" } });
    expect(screen.getByRole("menuitem", { name: /Nenhum item/ }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(field, { key: "Escape" });
    expect((field as HTMLInputElement).value).toBe("");
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(document.activeElement?.getAttribute("role")).toBe("menuitem");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
