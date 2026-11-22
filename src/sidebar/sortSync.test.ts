import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo } from "../ipc/types";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { resetDocsForTests, useDocs } from "../store/docs";
import { resetPrefsForTests, setPrefs } from "../store/prefs";
import { startSortSync } from "./sortSync";

const doc = (id: number, name: string, rev = 0): DocInfo => ({
  id, path: `/p/${name}`, name, format: "png", width: 10, height: 10, frames: 1,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev, error: null,
});
const order = () => useDocs.getState().docs.map((d) => d.id);
const settle = () => new Promise((r) => setTimeout(r, 0));

let stop = () => {};
beforeEach(() => {
  invoke.mockReset();
  resetDocsForTests();
  resetPrefsForTests();
  useDocs.setState({ docs: [doc(1, "b.png"), doc(2, "c.png"), doc(3, "a.png")], activeId: 1 });
});
afterEach(() => stop());

describe("startSortSync", () => {
  it("manual não mexe na ordem", async () => {
    stop = startSortSync();
    await settle();
    expect(order()).toEqual([1, 2, 3]);
  });

  it("ordena por nome ao escolher e quando entram documentos novos", async () => {
    stop = startSortSync();
    setPrefs({ sortBy: "name" });
    await settle();
    expect(order()).toEqual([3, 1, 2]);
    useDocs.getState().add([doc(4, "aa.png")]);
    await settle();
    expect(order()).toEqual([3, 4, 1, 2]);
  });

  it("data pede as estatísticas ao Rust uma vez por revisão", async () => {
    invoke.mockImplementation(async (_c: string, a: { ids: number[] }) =>
      a.ids.map((id) => ({ id, modifiedMs: id * 10, size: 1 })),
    );
    stop = startSortSync();
    setPrefs({ sortBy: "date" });
    await settle();
    expect(order()).toEqual([3, 2, 1]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("file_stats", { ids: [1, 2, 3] });
    useDocs.getState().setActive(2);
    await settle();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("voltar para manual durante o file_stats preserva o arraste", async () => {
    let responder: (v: unknown) => void = () => {};
    invoke.mockImplementation(() => new Promise((r) => (responder = r)));
    stop = startSortSync();
    setPrefs({ sortBy: "date" });
    await settle();
    setPrefs({ sortBy: "manual" });
    responder([1, 2, 3].map((id) => ({ id, modifiedMs: id * 10, size: 1 })));
    await settle();
    expect(order()).toEqual([1, 2, 3]);
  });

  it("falha no file_stats não derruba a barra", async () => {
    invoke.mockRejectedValue({ code: "io" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    stop = startSortSync();
    setPrefs({ sortBy: "size" });
    await settle();
    expect(order()).toHaveLength(3);
  });
});
