// Copiar, recortar, colar, duplicar, mover com setas e Alt+arrastar das anotações.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo } from "../ipc/types";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("./render", async (orig) => ({
  ...(await orig<typeof import("./render")>()),
  renderPng: vi.fn(async () => new Uint8Array([1, 2, 3])),
  flattenToPng: vi.fn(async () => new Uint8Array([9])),
}));

import "./register";
import "../select/register";
import { undo } from "../edit/history";
import { Slot } from "../lib/slots";
import { registerAppCommands } from "../shortcuts/appCommands";
import { isEnabled, runCommand } from "../shortcuts/commands";
import { matchShortcut } from "../shortcuts/keymap";
import { resetDocsForTests, useDocs } from "../store/docs";
import { useSelection } from "../store/selection";
import { resetUiForTests, useUi } from "../store/ui";
import { addAnnotation } from "./actions";
import { resetHistoryForTests } from "./history";
import { DEFAULT_STYLE, type Annotation } from "./model";
import { renderPng } from "./render";
import { getItems, getSelected, resetMarkupForTests, useMarkup } from "./store";

const info = (id: number, extra: Partial<DocInfo> = {}): DocInfo => ({
  id, path: `/p/ação ${id}.png`, name: `ação ${id}.png`, format: "png", width: 400, height: 300, frames: 1,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 1, error: null, ...extra,
});
const overlay = { scale: 1, panX: 0, panY: 0, imageW: 400, imageH: 300 };
const rect = (id: string, x = 10, y = 10): Annotation => ({ id, kind: "rect", geom: { x, y, w: 50, h: 50 }, style: { ...DEFAULT_STYLE } });
const text: Annotation = { id: "t", kind: "text", geom: { x: 100, y: 100, w: 80, h: 30, text: "Ação, você" }, style: { ...DEFAULT_STYLE } };

/** Área de transferência do núcleo: o que foi copiado, se ainda for o que está lá. */
let clip: string | null = null;
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const geoms = (id = 7) => getItems(id).map((a) => a.geom);
const key = async (k: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  act(() => void document.body.dispatchEvent(e));
  await flush();
  return e;
};
const keyUp = (k: string) => act(() => void document.body.dispatchEvent(new KeyboardEvent("keyup", { key: k, bubbles: true })));
const layer = () => screen.getByTestId("markup-layer");
type Mods = { shiftKey?: boolean; altKey?: boolean };
const down = (x: number, y: number, m: Mods = {}) => fireEvent.pointerDown(layer(), { button: 0, clientX: x, clientY: y, pointerId: 1, ...m });
const move = (x: number, y: number, m: Mods = {}) => fireEvent.pointerMove(layer(), { clientX: x, clientY: y, pointerId: 1, ...m });
const up = (x: number, y: number, m: Mods = {}) => fireEvent.pointerUp(layer(), { clientX: x, clientY: y, pointerId: 1, ...m });
const run = async (id: Parameters<typeof runCommand>[0]) => {
  let ok = false;
  act(() => void (ok = runCommand(id)));
  await flush();
  return ok;
};

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;
});
let off: () => void;
beforeEach(() => {
  clip = null;
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args?: { data?: string }) => {
    if (cmd === "copy_annotations") clip = args!.data!;
    if (cmd === "pasted_annotations") return clip;
    if (cmd === "copy_image") clip = null;
    if (cmd === "clipboard_image") throw { code: "clipboard_empty", message: "" };
  });
  resetDocsForTests();
  resetUiForTests();
  useDocs.getState().add([info(7), info(8, { width: 100, height: 80 })]);
  useDocs.setState({ activeId: 7 });
  resetMarkupForTests();
  resetHistoryForTests();
  useMarkup.setState({ visible: true });
  useSelection.setState({ selection: null, selectionTool: null });
  off = registerAppCommands();
  addAnnotation(7, rect("a"), false);
  addAnnotation(7, text, false);
  render(<Slot name="viewport-overlay" props={overlay} />);
});
afterEach(() => {
  off();
  cleanup();
});

describe("copiar e colar", () => {
  it("Ctrl+C copia a anotação selecionada; sem anotação selecionada, a imagem", async () => {
    await run("edit.copy");
    expect(invoke).toHaveBeenLastCalledWith("copy_image", expect.anything());
    act(() => useMarkup.getState().select(7, ["t"]));
    await run("edit.copy");
    expect(invoke).toHaveBeenLastCalledWith("copy_annotations", { data: expect.stringContaining("Ação, você"), png: [1, 2, 3] });
    expect(renderPng).toHaveBeenLastCalledWith([text], expect.objectContaining({ x: expect.any(Number) }), 400, 300, null);
  });

  it("colar põe uma cópia deslocada, selecionada, num passo só do desfazer", async () => {
    act(() => useMarkup.getState().select(7, ["a"]));
    await run("edit.copy");
    await run("edit.paste");
    expect(geoms()[2]).toEqual({ x: 22, y: 22, w: 50, h: 50 });
    const [, , copy] = getItems(7);
    expect(copy.id).not.toBe("a");
    expect(getSelected(7)).toEqual([copy.id]);
    await run("edit.paste"); // outra cópia não cai em cima da primeira
    expect(geoms()[3]).toEqual({ x: 34, y: 34, w: 50, h: 50 });
    await act(async () => void (await undo(7)));
    expect(getItems(7)).toHaveLength(3);
  });

  it("cola em outro documento, na página mostrada, e traz para dentro o que ficaria fora", async () => {
    act(() => useMarkup.getState().select(7, ["a", "t"]));
    await run("edit.copy");
    useDocs.getState().add([info(9, { format: "tiff", frames: 3 })]);
    act(() => useDocs.setState({ activeId: 9 }));
    act(() => useUi.setState({ page: 2 }));
    await run("edit.paste");
    expect(getItems(9).map((a) => [a.kind, a.page])).toEqual([["rect", 2], ["text", 2]]);
    expect(geoms(9)[0]).toEqual({ x: 10, y: 10, w: 50, h: 50 });
    act(() => useUi.setState({ page: null }));

    act(() => useDocs.setState({ activeId: 7 }));
    act(() => useMarkup.getState().select(7, ["t"]));
    await run("edit.copy");
    act(() => useDocs.setState({ activeId: 8 }));
    await run("edit.paste");
    expect(geoms(8)[0]).toMatchObject({ x: 10, y: 25 }); // 100×80: centralizada
  });

  it("o que chega da área de transferência é validado", async () => {
    clip = JSON.stringify({ items: [rect("ok"), { id: "x", kind: "image", geom: { x: 0, y: 0, w: 1, h: 1, src: "http://x" }, style: DEFAULT_STYLE }] });
    await run("edit.paste");
    expect(getItems(7).map((a) => a.kind)).toEqual(["rect", "text", "rect"]);
  });

  it("copiar a imagem depois volta a valer para o Colar", async () => {
    act(() => useMarkup.getState().select(7, ["a"]));
    await run("edit.copy");
    act(() => useMarkup.getState().select(7, []));
    await run("edit.copy");
    await run("edit.paste");
    expect(invoke).toHaveBeenLastCalledWith("clipboard_image");
    expect(getItems(7)).toHaveLength(2);
  });

  it("recortar copia e apaga só as copiadas; Apagar do menu apaga a anotação, não a imagem", async () => {
    expect(isEnabled("edit.cut")).toBe(false);
    act(() => useMarkup.getState().select(7, ["a"]));
    expect(isEnabled("edit.cut")).toBe(true);
    await run("edit.cut");
    expect(getItems(7).map((a) => a.id)).toEqual(["t"]);
    await run("edit.paste");
    expect(geoms()[1]).toEqual({ x: 10, y: 10, w: 50, h: 50 }); // no mesmo lugar
    expect(isEnabled("edit.delete")).toBe(true);
    await run("edit.delete");
    expect(getItems(7).map((a) => a.id)).toEqual(["t"]);
    expect(invoke.mock.calls.filter((c) => c[0] === "apply_op")).toEqual([]);
  });

  it("se a cópia falha, o Recortar não apaga nada", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "copy_annotations") throw { code: "io", message: "sem área de transferência" };
    });
    act(() => useMarkup.getState().select(7, ["a"]));
    await run("edit.cut");
    expect(getItems(7)).toHaveLength(2);
  });

  it("com a barra oculta ou uma ferramenta de seleção, vale a imagem", async () => {
    act(() => useMarkup.getState().select(7, ["a"]));
    act(() => useSelection.setState({ selectionTool: "rect" }));
    await run("edit.copy");
    expect(invoke).toHaveBeenLastCalledWith("copy_image", expect.anything());
    act(() => useSelection.setState({ selectionTool: null }));
    act(() => useMarkup.getState().setVisible(false));
    await run("edit.copy");
    expect(invoke).toHaveBeenLastCalledWith("copy_image", expect.anything());
  });
});

describe("duplicar e selecionar", () => {
  it("Ctrl+D duplica as selecionadas", async () => {
    expect(matchShortcut(new KeyboardEvent("keydown", { key: "d", code: "KeyD", ctrlKey: true }))).toBe("edit.duplicate");
    expect(isEnabled("edit.duplicate")).toBe(false);
    act(() => useMarkup.getState().select(7, ["a"]));
    await run("edit.duplicate");
    expect(geoms()[2]).toEqual({ x: 22, y: 22, w: 50, h: 50 });
    expect(getSelected(7)).toEqual([getItems(7)[2].id]);
  });

  it("Selecionar Tudo: com uma anotação selecionada, todas as da página; sem, a imagem", async () => {
    await run("edit.selectAll");
    expect(useSelection.getState().selection).not.toBeNull();
    act(() => useSelection.getState().setSelection(null));
    act(() => useMarkup.getState().select(7, ["a"]));
    await run("edit.selectAll");
    expect(getSelected(7)).toEqual(["a", "t"]);
    expect(useSelection.getState().selection).toBeNull();
  });

  it("Shift+clique soma e tira da seleção", () => {
    down(30, 30);
    up(30, 30);
    down(110, 110, { shiftKey: true });
    up(110, 110);
    expect(getSelected(7)).toEqual(["a", "t"]);
    down(30, 30, { shiftKey: true });
    up(30, 30);
    expect(getSelected(7)).toEqual(["t"]);
  });

  it("Shift+clique na área vazia não perde a seleção", () => {
    act(() => useMarkup.getState().select(7, ["a"]));
    down(300, 250, { shiftKey: true });
    expect(getSelected(7)).toEqual(["a"]);
  });

  it("Alt+arrastar deixa a original e move a cópia, num passo só", async () => {
    down(30, 30, { altKey: true });
    move(60, 40, { altKey: true });
    move(80, 40, { altKey: true });
    up(80, 40, { altKey: true });
    expect(geoms().map((g) => [(g as { x: number }).x, (g as { y: number }).y])).toEqual([[10, 10], [100, 100], [60, 20]]);
    expect(getSelected(7)).toEqual([getItems(7)[2].id]);
    await act(async () => void (await undo(7)));
    expect(getItems(7).map((a) => a.id)).toEqual(["a", "t"]);
  });

  it("Alt+clique sem arrastar não duplica", () => {
    down(30, 30, { altKey: true });
    up(30, 30, { altKey: true });
    expect(getItems(7)).toHaveLength(2);
  });
});

describe("setas", () => {
  it("movem 1 px, 10 com Shift; segurar a tecla é um passo só do desfazer", async () => {
    act(() => useMarkup.getState().select(7, ["a"]));
    const e = await key("ArrowRight");
    expect(e.defaultPrevented).toBe(true);
    await key("ArrowRight", { repeat: true });
    await key("ArrowRight", { repeat: true });
    keyUp("ArrowRight");
    expect(geoms()[0]).toMatchObject({ x: 13, y: 10 });
    await key("ArrowUp", { shiftKey: true });
    keyUp("ArrowUp");
    expect(geoms()[0]).toMatchObject({ x: 13, y: 0 });
    await act(async () => void (await undo(7)));
    expect(geoms()[0]).toMatchObject({ x: 13, y: 10 });
    await act(async () => void (await undo(7)));
    expect(geoms()[0]).toMatchObject({ x: 10, y: 10 });
  });

  it("outra tecla fecha o passo antes de agir (desfazer com a seta ainda apertada)", async () => {
    act(() => useMarkup.getState().select(7, ["a"]));
    await key("ArrowRight");
    await key("z", { ctrlKey: true });
    await act(async () => void (await undo(7)));
    expect(geoms()[0]).toMatchObject({ x: 10, y: 10 });
  });

  it("sem anotação selecionada continuam navegando; com seleção da imagem, a anotação tem prioridade", async () => {
    expect((await key("ArrowRight")).defaultPrevented).toBe(false);
    act(() => useSelection.getState().setSelection({ type: "rect", data: { x: 5, y: 5, w: 10, h: 10 } }));
    act(() => useMarkup.getState().select(7, ["a"]));
    await key("ArrowRight");
    keyUp("ArrowRight");
    expect(geoms()[0]).toMatchObject({ x: 11 });
    expect(useSelection.getState().selection).toEqual({ type: "rect", data: { x: 5, y: 5, w: 10, h: 10 } });
  });
});

describe("Shift e Alt no ponteiro", () => {
  it("Shift durante a criação vale até soltar", () => {
    act(() => useMarkup.getState().setTool("rect"));
    down(200, 200);
    move(240, 220, { shiftKey: true });
    up(240, 220, { shiftKey: true });
    expect(geoms()[2]).toEqual({ x: 200, y: 200, w: 40, h: 40 });
  });

  it("Alt na alça redimensiona a partir do centro (e não duplica)", () => {
    act(() => useMarkup.getState().select(7, ["a"]));
    down(60, 60, { altKey: true });
    move(70, 70, { altKey: true });
    up(70, 70, { altKey: true });
    expect(getItems(7)).toHaveLength(2);
    expect(geoms()[0]).toEqual({ x: 0, y: 0, w: 70, h: 70 });
  });
});
