// Arrastar e soltar arquivos na janela: segue Preferências › Abrir arquivos e só marca o lugar com arquivos.
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocId, DocInfo } from "../ipc/types";

const tabs = vi.hoisted(() => ({
  openHere: vi.fn<(p: string[]) => Promise<unknown[]>>(),
  moveDocs: vi.fn<(ids: number[], deliver: unknown) => Promise<boolean>>(),
}));
vi.mock("../tabs/open", () => ({ openHere: tabs.openHere, notElsewhere: async (p: string[]) => p }));
vi.mock("../tabs/transfer", () => ({ moveDocs: tabs.moveDocs }));
const webview = vi.hoisted(() => ({ drag: (() => {}) as (payload: unknown) => void }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async (cb: (e: { payload: unknown }) => void) => {
      webview.drag = (payload) => cb({ payload });
      return () => {};
    },
  }),
}));

import { resetDocsForTests, useDocs } from "../store/docs";
import { resetPrefsForTests, setPrefs } from "../store/prefs";
import { resetUiForTests } from "../store/ui";
import { openDropped, registerDropHover, registerDropTarget, useFileDrop } from "./fileDrop";

const info = (id: number): DocInfo => ({
  id, path: `/p/ação ${id}.png`, name: `ação ${id}.png`, format: "png", width: 40, height: 30, frames: 1,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 0, error: null,
});

beforeEach(() => {
  resetDocsForTests();
  resetPrefsForTests();
  resetUiForTests();
  tabs.openHere.mockReset().mockImplementation(async (paths) => {
    const docs = paths.map((_, i) => info(i + 2));
    useDocs.getState().add(docs);
    return docs;
  });
  tabs.moveDocs.mockReset().mockImplementation(async (moved: DocId[]) => {
    useDocs.getState().detach(moved);
    return true;
  });
});

describe("soltar arquivos", () => {
  it("em janelas separadas: cada arquivo solto vai para uma janela própria", async () => {
    setPrefs({ openFilesIn: "windows" });
    useDocs.getState().add([info(1)]);
    await openDropped(["/p/ação 2.png", "/p/ação 3.png"]);
    expect(tabs.moveDocs.mock.calls.map(([ids]) => ids)).toEqual([[2], [3]]);
  });

  it("na mesma janela: abre aqui e mostra o primeiro", async () => {
    useDocs.getState().add([info(1)]);
    await openDropped(["/p/ação 2.png", "/p/ação 3.png"]);
    expect(tabs.moveDocs).not.toHaveBeenCalled();
    expect(useDocs.getState().activeId).toBe(2);
  });

  it("arrasto sem arquivos (texto, link) não mostra a marca de soltura", async () => {
    const hover = vi.fn(() => true);
    const off = registerDropHover(hover);
    const { result } = renderHook(() => useFileDrop());
    await act(async () => {});
    act(() => webview.drag({ type: "enter", paths: [], position: { x: 10, y: 10 } }));
    act(() => webview.drag({ type: "over", position: { x: 20, y: 20 } }));
    expect(result.current).toBe(false);
    expect(hover.mock.calls.filter(([at]) => at !== null)).toEqual([]);
    act(() => webview.drag({ type: "enter", paths: ["/p/ação 2.png"], position: { x: 10, y: 10 } }));
    expect(hover).toHaveBeenLastCalledWith({ x: 10, y: 10 });
    off();
  });

  it("soltar sem arquivos não chega aos alvos nem abre nada", async () => {
    const target = vi.fn(() => true);
    const off = registerDropTarget(target);
    renderHook(() => useFileDrop());
    await act(async () => {});
    act(() => webview.drag({ type: "drop", paths: [], position: { x: 10, y: 10 } }));
    expect(target).not.toHaveBeenCalled();
    expect(tabs.openHere).not.toHaveBeenCalled();
    off();
  });
});
