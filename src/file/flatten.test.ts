// Salvar e Exportar achatam as anotações (Task 8) antes de gravar.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo } from "../ipc/types";

const order: string[] = [];
const ipc = vi.hoisted(() => ({
  // registerFileCommands também liga a instância única e o scanner.
  takeOpenRequests: async () => [], scanAvailable: async () => false,
  save: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  saveNeedsExport: vi.fn(async () => false),
  exportDoc: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
}));
vi.mock("../ipc/commands", () => ipc);
vi.mock("../markup/flatten", () => ({
  flattenAnnotations: vi.fn(async (id: number) => {
    order.push(`flatten:${id}`);
    return true;
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onCloseRequested: vi.fn(async () => () => {}) }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

import { useDocs } from "../store/docs";
import { exportDoc, saveDoc } from "./fileActions";
import { registerFileCommands } from "./register";

const doc: DocInfo = {
  id: 7, path: "/f/a.png", name: "a.png", format: "png", width: 4, height: 4, frames: 1,
  writable: true, dirty: true, canUndo: true, canRedo: false, rev: 1, error: null,
};

let off: () => void;
beforeEach(() => {
  order.length = 0;
  useDocs.setState({ docs: [doc], activeId: 7 });
  ipc.save.mockImplementation(async () => {
    order.push("save");
    return { type: "saved", data: { ...doc, dirty: false, rev: 2 } };
  });
  ipc.exportDoc.mockImplementation(async () => {
    order.push("export");
    return doc;
  });
  off = registerFileCommands();
});
afterEach(() => off());

describe("achatamento antes de gravar", () => {
  it("Salvar achata e só então grava", async () => {
    await saveDoc(doc);
    expect(order).toEqual(["flatten:7", "save"]);
  });

  it("Exportar achata e só então grava", async () => {
    await exportDoc(7, "/f/b.webp", {
      format: "webp", quality: null, alpha: true, depth16: false, stripMetadata: false, resize: null,
    });
    expect(order).toEqual(["flatten:7", "export"]);
  });
});
