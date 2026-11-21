import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo } from "../ipc/types";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { getItems, getSelected, useMarkup } from "../markup/store";
import { useDocs } from "../store/docs";
import { useSelection } from "../store/selection";
import { useUi } from "../store/ui";
import { dropOnImage, layerBox, pasteAsLayer, pngSize } from "./paste";

const info = (extra: Partial<DocInfo> = {}): DocInfo => ({
  id: 1, path: "/x/a.png", name: "a.png", format: "png", width: 100, height: 80, frames: 1,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 0, error: null, ...extra,
});

/** Cabeçalho PNG mínimo (assinatura + IHDR) com o tamanho pedido. */
function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, w);
  v.setUint32(20, h);
  return b;
}

const answer = (bytes: Uint8Array) => async (cmd: string) => {
  if (cmd === "clipboard_image" || cmd === "image_file_png") return bytes.buffer;
  if (cmd === "new_from_clipboard") return info({ id: 2, path: null as unknown as string, name: "Sem título" });
  throw new Error(`inesperado: ${cmd}`);
};

describe("colar como camada", () => {
  beforeEach(() => {
    invoke.mockReset();
    useDocs.setState({ docs: [info()], activeId: 1 });
    useSelection.setState({ selection: { type: "rect", data: { x: 0, y: 0, w: 5, h: 5 } }, selectionTool: "rect" });
    useMarkup.setState({ visible: false, tool: "rect", docs: {}, selected: {} });
    useUi.setState({ view: null, viewSize: { w: 0, h: 0 } });
  });

  it("pngSize lê o IHDR; bytes que não são PNG dão null", () => {
    expect(pngSize(png(640, 480))).toEqual({ w: 640, h: 480 });
    expect(pngSize(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it("layerBox mantém 1:1, centra no ponto e não sai da imagem", () => {
    expect(layerBox({ w: 20, h: 10 }, { w: 100, h: 80 }, [50, 40])).toEqual({ x: 40, y: 35, w: 20, h: 10 });
    expect(layerBox({ w: 20, h: 10 }, { w: 100, h: 80 }, [2, 79])).toEqual({ x: 0, y: 70, w: 20, h: 10 });
  });

  it("layerBox reduz o que é maior que a imagem, mantendo a proporção", () => {
    expect(layerBox({ w: 400, h: 100 }, { w: 100, h: 80 }, [50, 40])).toEqual({ x: 0, y: 27.5, w: 100, h: 25 });
  });

  it("cria uma anotação de imagem selecionada, no centro da área visível, com a barra de Marcação", async () => {
    invoke.mockImplementation(answer(png(20, 10)));
    useUi.setState({ view: { scale: 2, panX: 0, panY: 0, mode: "free" }, viewSize: { w: 100, h: 100 } });
    await pasteAsLayer();
    const [a] = getItems(1);
    expect(a.kind).toBe("image");
    expect(a.geom).toMatchObject({ x: 15, y: 20, w: 20, h: 10 });
    expect((a.geom as { src: string }).src.startsWith("data:image/png;base64,")).toBe(true);
    expect(getSelected(1)).toEqual([a.id]);
    const mk = useMarkup.getState();
    expect(mk.visible).toBe(true);
    expect(mk.tool).toBe("select");
    expect(useSelection.getState().selection).toBeNull();
  });

  it("sem documento editável, Colar cria um documento novo (Novo da Área de Transferência)", async () => {
    invoke.mockImplementation(answer(png(20, 10)));
    useDocs.setState({ docs: [], activeId: null });
    await pasteAsLayer();
    expect(invoke.mock.calls.map((c) => c[0])).toEqual(["new_from_clipboard"]);
  });

  it("área de transferência sem PNG válido não cria anotação", async () => {
    invoke.mockImplementation(answer(new Uint8Array([1, 2, 3])));
    await expect(pasteAsLayer()).rejects.toBeTruthy();
    expect(getItems(1)).toEqual([]);
  });

  it("soltar um arquivo de imagem sobre a imagem vira camada centrada no ponto", async () => {
    invoke.mockImplementation(answer(png(10, 10)));
    useUi.setState({ view: { scale: 1, panX: 0, panY: 0, mode: "free" }, viewSize: { w: 100, h: 80 } });
    expect(dropOnImage(["/x/b.png"], [30, 30])).toBe(true);
    await vi.waitFor(() => expect(getItems(1)).toHaveLength(1));
    expect(invoke).toHaveBeenCalledWith("image_file_png", { path: "/x/b.png" });
    expect(getItems(1)[0].geom).toMatchObject({ x: 25, y: 25, w: 10, h: 10 });
  });

  it("soltar fora da imagem, vários arquivos ou arquivo que não é imagem abre como documento", () => {
    useUi.setState({ view: { scale: 1, panX: 0, panY: 0, mode: "free" }, viewSize: { w: 300, h: 300 } });
    expect(dropOnImage(["/x/b.png"], [150, 150])).toBe(false);
    expect(dropOnImage(["/x/b.png", "/x/c.png"], [30, 30])).toBe(false);
    expect(dropOnImage(["/x/b.txt"], [30, 30])).toBe(false);
    useDocs.setState({ docs: [], activeId: null });
    expect(dropOnImage(["/x/b.png"], [30, 30])).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});
