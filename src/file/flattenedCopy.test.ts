// Duplicar com anotações não salvas: achata numa cópia, nunca no documento aberto (Imprimir e PDF: src/print).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo } from "../ipc/types";

const ipc = vi.hoisted(() => ({
  // registerFileCommands também liga a instância única e o scanner.
  takeOpenRequests: async () => [], scanAvailable: async () => false,
  duplicate: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  applyOp: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  closeDocument: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => {}),
  save: vi.fn(),
  exportDoc: vi.fn(),
}));
vi.mock("../ipc/commands", () => ipc);
vi.mock("../markup/render", async (orig) => ({
  ...(await orig<typeof import("../markup/render")>()),
  flattenToPng: vi.fn(async () => new Uint8Array([1, 2, 3])),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onCloseRequested: vi.fn(async () => () => {}) }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

import { useDocs } from "../store/docs";
import { getItems, useMarkup } from "../markup/store";
import type { Annotation } from "../markup/model";
import { hasUnsaved, registerDirtySource } from "./dirty";
import { duplicateActive } from "./fileActions";
import { registerFileCommands } from "./register";

const doc: DocInfo = {
  id: 7, path: "/f/a.png", name: "a.png", format: "png", width: 4, height: 4, frames: 1,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 1, error: null,
};
const copy: DocInfo = { ...doc, id: 8, path: "", name: "a cópia", dirty: true };
const rect = { id: "r1", kind: "rect", x: 0, y: 0, w: 2, h: 2 } as unknown as Annotation;
const PNG = new Uint8Array([1, 2, 3]);
// Como no `markup/register.ts`: anotações não achatadas deixam o documento "sujo".
registerDirtySource((id) => getItems(id).length > 0);

let off: () => void;
beforeEach(() => {
  vi.clearAllMocks();
  off = registerFileCommands();
  useDocs.setState({ docs: [doc], activeId: 7 });
  useMarkup.setState({ docs: { 7: [rect] }, selected: {} });
  ipc.duplicate.mockResolvedValue(copy);
  ipc.applyOp.mockImplementation(async (id) => ({ ...copy, id, rev: 2 }));
});

/** O documento aberto continua igual: anotações editáveis, sem passo novo, ainda "sujo". */
const originalUntouched = () => {
  expect(ipc.applyOp.mock.calls.every(([id]) => id !== 7)).toBe(true);
  expect(getItems(7)).toEqual([rect]);
  const now = useDocs.getState().docs.find((d) => d.id === 7);
  expect(now).toEqual(doc);
  expect(hasUnsaved(now!)).toBe(true);
};

afterEach(() => off());

describe("cópia achatada", () => {
  it("Duplicar põe as anotações achatadas só na cópia", async () => {
    await duplicateActive();
    expect(ipc.applyOp).toHaveBeenCalledWith(8, { type: "composite", data: { png: PNG } });
    expect(useDocs.getState().activeId).toBe(8);
    expect(getItems(8)).toEqual([]);
    originalUntouched();
  });
});
