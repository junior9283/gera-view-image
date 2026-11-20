import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo } from "../ipc/types";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
const setFullscreen = vi.fn(async () => {});
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setFullscreen }) }));

import { resetDocsForTests, useDocs } from "../store/docs";
import { resetPrefsForTests, setPrefs } from "../store/prefs";
import { resetUiForTests, useUi } from "../store/ui";
import { confirmClose } from "../file/unsaved";
import * as actions from "./actions";

const info = (id: number, extra: Partial<DocInfo> = {}): DocInfo => ({
  id, path: `/pasta/${id}.png`, name: `${id}.png`, format: "png", width: 4000, height: 3000, frames: 1,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 0, error: null, ...extra,
});

const ids = () => useDocs.getState().docs.map((d) => d.id);
const active = () => useDocs.getState().activeId;

beforeEach(() => {
  invoke.mockReset();
  setFullscreen.mockClear();
  resetDocsForTests();
  resetPrefsForTests();
  resetUiForTests();
});

describe("navegação entre os abertos", () => {
  beforeEach(() => {
    useDocs.getState().add([info(1), info(2), info(3)]);
  });

  it("next/prev andam sem dar a volta", async () => {
    await actions.next();
    expect(active()).toBe(2);
    await actions.next();
    await actions.next();
    expect(active()).toBe(3);
    await actions.prev();
    expect(active()).toBe(2);
  });

  it("first/last vão para as pontas", async () => {
    await actions.last();
    expect(active()).toBe(3);
    await actions.first();
    expect(active()).toBe(1);
  });

  it("wrap dá a volta (apresentação)", async () => {
    await actions.last();
    await actions.next({ wrap: true });
    expect(active()).toBe(1);
    await actions.prev({ wrap: true });
    expect(active()).toBe(3);
  });

  it("documento com erro continua navegável", async () => {
    useDocs.getState().update(info(2, { error: "corrupt", rev: 1 }));
    await actions.next();
    expect(active()).toBe(2);
    await actions.next();
    expect(active()).toBe(3);
  });
});

describe("navegação na pasta", () => {
  const folder = ["/pasta/0.png", "/pasta/1.png", "/pasta/2.png"];

  beforeEach(() => {
    invoke.mockImplementation(async (cmd: string, args: { paths?: string[]; id?: number }) => {
      if (cmd === "folder_images") return folder;
      if (cmd === "open_documents") return args.paths!.map((p) => info(Number(p.match(/(\d+)\.png/)![1]) + 10, { path: p }));
      return undefined;
    });
  });

  it("com um só aberto abre o vizinho da pasta e fecha o anterior limpo", async () => {
    useDocs.getState().add([info(1, { path: "/pasta/1.png" })]);
    await actions.next();
    expect(invoke).toHaveBeenCalledWith("folder_images", { path: "/pasta/1.png" });
    expect(invoke).toHaveBeenCalledWith("open_documents", { paths: ["/pasta/2.png"] });
    expect(invoke).toHaveBeenCalledWith("close_document", { id: 1 });
    expect(ids()).toEqual([12]);
    expect(active()).toBe(12);
    await actions.first();
    expect(ids()).toEqual([10]);
  });

  it("na ponta da pasta não faz nada", async () => {
    useDocs.getState().add([info(1, { path: "/pasta/2.png" })]);
    await actions.next();
    expect(ids()).toEqual([1]);
    expect(invoke).not.toHaveBeenCalledWith("open_documents", expect.anything());
  });

  it("documento sujo fica aberto enquanto não houver diálogo", async () => {
    useDocs.getState().add([info(1, { path: "/pasta/1.png", dirty: true })]);
    await actions.prev();
    expect(ids()).toEqual([1, 10]);
    expect(active()).toBe(10);
    expect(invoke).not.toHaveBeenCalledWith("close_document", expect.anything());
  });

  it("sem browseFolder não percorre a pasta", async () => {
    setPrefs({ browseFolder: false });
    useDocs.getState().add([info(1, { path: "/pasta/1.png" })]);
    await actions.next();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("zoom", () => {
  beforeEach(() => {
    useDocs.getState().add([info(1)]);
    useUi.getState().setViewSize({ w: 800, h: 600 });
  });

  it("fitToWindow, actualSize, zoomIn e zoomOut mudam a escala", () => {
    actions.fitToWindow();
    expect(useUi.getState().view).toMatchObject({ scale: 0.2, mode: "fit" });
    actions.zoomIn();
    expect(useUi.getState().view!.scale).toBe(0.25);
    actions.zoomOut();
    expect(useUi.getState().view!.scale).toBe(0.1);
    actions.zoomOut();
    actions.zoomOut();
    expect(useUi.getState().view!.scale).toBe(0.05);
    actions.actualSize();
    expect(useUi.getState().view).toMatchObject({ scale: 1, mode: "actual" });
  });

  it("zoom sem documento ativo é ignorado", () => {
    resetDocsForTests();
    actions.zoomIn();
    expect(useUi.getState().view).toBeNull();
  });
});

describe("barra lateral, tela cheia e apresentação", () => {
  it("toggleSidebar alterna entre o modo pedido e oculto", () => {
    actions.toggleSidebar("thumbs");
    expect(useUi.getState().sidebar).toBe("thumbs");
    actions.toggleSidebar("contact");
    expect(useUi.getState().sidebar).toBe("contact");
    actions.toggleSidebar("contact");
    expect(useUi.getState().sidebar).toBe("hidden");
  });

  it("toggleFullscreen chama a janela", async () => {
    await actions.toggleFullscreen();
    expect(setFullscreen).toHaveBeenLastCalledWith(true);
    expect(useUi.getState().fullscreen).toBe(true);
    await actions.toggleFullscreen();
    expect(setFullscreen).toHaveBeenLastCalledWith(false);
    expect(useUi.getState().fullscreen).toBe(false);
  });

  it("apresentação entra em tela cheia e restaura o estado anterior ao sair", async () => {
    useDocs.getState().add([info(1)]);
    await actions.startSlideshow();
    expect(useUi.getState()).toMatchObject({ slideshow: true, fullscreen: true });
    await actions.stopSlideshow();
    expect(useUi.getState()).toMatchObject({ slideshow: false, fullscreen: false });
    expect(setFullscreen).toHaveBeenLastCalledWith(false);
  });

  it("apresentação sem documentos não começa", async () => {
    await actions.startSlideshow();
    expect(useUi.getState().slideshow).toBe(false);
  });
});

describe("unsaved (stub até a Tarefa 11)", () => {
  it("descarta quando nada está sujo e cancela se houver sujo", async () => {
    expect(await confirmClose([info(1)])).toBe("discard");
    expect(await confirmClose([info(1), info(2, { dirty: true })])).toBe("cancel");
  });

  it("closeDocs fecha só se confirmClose permitir", async () => {
    useDocs.getState().add([info(1), info(2, { dirty: true })]);
    await actions.closeDocs([1]);
    expect(ids()).toEqual([2]);
    await actions.closeDocs([2]);
    expect(ids()).toEqual([2]);
  });
});
