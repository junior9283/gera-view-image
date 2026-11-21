// Estado não salvo além do `DocInfo.dirty`: anotações (Task 8) e palavras-chave (Task 10).
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo } from "../ipc/types";

const ipc = vi.hoisted(() => ({
  save: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  exportDoc: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  revert: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  applyOp: vi.fn(),
  undo: vi.fn(),
  redo: vi.fn(),
}));
vi.mock("../ipc/commands", () => ipc);
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onCloseRequested: vi.fn(async () => () => {}) }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
const toast = vi.hoisted(() => vi.fn());
vi.mock("../chrome/notify", () => ({ notify: toast, notifyError: vi.fn() }));

import "../markup/register";
import { DEFAULT_STYLE, type Annotation } from "../markup/model";
import { canUndo, pushMarkup, undo } from "../markup/history";
import { getItems, useMarkup } from "../markup/store";
import { addKeyword, getPendingKeywords, resetKeywordsForTests } from "../inspector/keywords";
import { isEnabled } from "../shortcuts/commands";
import { useDocs } from "../store/docs";
import { setPrefs } from "../store/prefs";
import { hasUnsaved } from "./dirty";
import { revert, saveDoc } from "./fileActions";
import { registerFileCommands } from "./register";
import { confirmClose, resetUnsavedForTests } from "./unsaved";
import { UnsavedDialog } from "./UnsavedDialog";

const doc = (over: Partial<DocInfo> = {}): DocInfo => ({
  id: 1, path: "/f/a.jpg", name: "a.jpg", format: "jpeg", width: 40, height: 20, frames: 1,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 1, error: null, ...over,
});
const rect: Annotation = { id: "r1", kind: "rect", geom: { x: 1, y: 1, w: 5, h: 5 }, style: { ...DEFAULT_STYLE } };

let off: () => void;
beforeEach(() => {
  vi.clearAllMocks();
  setPrefs({ language: "pt-BR" });
  resetUnsavedForTests();
  resetKeywordsForTests();
  useMarkup.getState().drop(1);
  useDocs.setState({ docs: [doc()], activeId: 1 });
  off = registerFileCommands();
  render(<UnsavedDialog />);
});
afterEach(() => {
  off();
  cleanup();
});

describe("estado não salvo além das Op", () => {
  it("doc limpo: não pergunta ao fechar e Salvar fica desabilitado", async () => {
    expect(hasUnsaved(doc())).toBe(false);
    expect(await confirmClose([doc()])).toBe("discard");
    expect(isEnabled("file.save")).toBe(false);
  });

  it("doc só com anotação: fechar mostra o diálogo e Salvar fica habilitado", async () => {
    act(() => useMarkup.getState().setItems(1, [rect]));
    expect(isEnabled("file.save")).toBe(true);
    act(() => void confirmClose([doc()]));
    expect((await screen.findByRole("alertdialog")).textContent).toContain("a.jpg");
  });

  it("só palavras-chave: Salvar habilitado e as grava (JPEG leva IPTC/XMP)", async () => {
    act(() => addKeyword(1, "praia"));
    expect(isEnabled("file.save")).toBe(true);
    ipc.save.mockResolvedValue({ type: "saved", data: doc({ rev: 2 }) });
    expect(await saveDoc(doc())).toBe(true);
    expect(ipc.save).toHaveBeenCalledWith(1, ["praia"]);
    expect(getPendingKeywords(1)).toBeNull();
    expect(isEnabled("file.save")).toBe(false);
  });

  it("formato sem IPTC/XMP (BMP): mantém as palavras-chave pendentes e avisa", async () => {
    const tif = doc({ format: "bmp", path: "/f/a.bmp", name: "a.bmp" });
    useDocs.setState({ docs: [tif], activeId: 1 });
    act(() => addKeyword(1, "praia"));
    ipc.save.mockResolvedValue({ type: "saved", data: { ...tif, rev: 2 } });
    expect(await saveDoc(tif)).toBe(true);
    expect(getPendingKeywords(1)).toEqual(["praia"]);
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("palavras-chave"));
  });
});

describe("Reverter", () => {
  it("descarta anotações e a pilha JS: desfazer depois não reaplica nada", async () => {
    useMarkup.getState().setItems(1, [rect]);
    pushMarkup(1, [], [rect]);
    ipc.revert.mockResolvedValue(doc({ rev: 3 }));
    await revert("original");
    expect(getItems(1)).toEqual([]);
    expect(canUndo(1)).toBe(false);
    await undo(1);
    expect(getItems(1)).toEqual([]);
    expect(ipc.undo).not.toHaveBeenCalled();
  });
});
