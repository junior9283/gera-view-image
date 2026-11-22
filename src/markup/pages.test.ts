// Documento de várias páginas (TIFF): das ações da interface até o `invoke`, sem simular o `ipc`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo } from "../ipc/types";

type Args = Record<string, unknown> & { id: number };
const invoke = vi.hoisted(() => vi.fn<(cmd: string, args: never) => Promise<unknown>>());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onCloseRequested: vi.fn(async () => () => {}) }) }));
const dialog = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => dialog);
vi.mock("./render", async (orig) => ({
  ...(await orig<typeof import("./render")>()),
  flattenToPng: vi.fn(async (items: { id: string }[]) => new TextEncoder().encode(items.map((i) => i.id).join(""))),
}));

import { getToasts, resetToastsForTests } from "../chrome/notify";
import { hasUnsaved } from "../file/dirty";
import { defaultOptions } from "../file/estimate";
import { duplicateActive, exportDoc, flattenedCopy, saveDoc, useFileUi } from "../file/fileActions";
import { registerFileCommands } from "../file/register";
import { saveAsActive } from "../finder/actions";
import { copySelection } from "../select/actions";
import { useDocs } from "../store/docs";
import { setPrefs } from "../store/prefs";
import { useUi } from "../store/ui";
import { addAnnotation, deleteSelected } from "./actions";
import { flattenAnnotations } from "./flatten";
import { resetHistoryForTests, undo } from "./history";
import { DEFAULT_STYLE, type Annotation } from "./model";
import { hasPages } from "./pages";
import "./register";
import { getItems, getSelected, resetMarkupForTests } from "./store";

const tiff: DocInfo = {
  id: 5, path: "/f/t.tiff", name: "t.tiff", format: "tiff", width: 4, height: 4, frames: 3,
  writable: false, dirty: false, canUndo: false, canRedo: false, rev: 1, error: null,
};
const other: DocInfo = { ...tiff, id: 6, path: "/f/o.tiff", name: "o.tiff" };
const rect = (id: string): Annotation => ({ id, kind: "rect", geom: { x: 0, y: 0, w: 2, h: 2 }, style: DEFAULT_STYLE });
const ids = (doc: number) => getItems(doc).map((a) => a.id);
const calls = (cmd: string) => invoke.mock.calls.filter(([c]) => c === cmd).map(([, a]) => a as unknown as Args);
/** `[documento, anotações achatadas, página]` de cada composite que chegou ao Rust. */
const composites = () =>
  calls("apply_op").map((a) => {
    const { png, frame } = (a.op as { data: { png: number[]; frame?: number } }).data;
    return [a.id, String.fromCharCode(...png), frame];
  });
const opts = (frame?: number) => ({ ...defaultOptions("png"), frame });
const pendingWarning = () => getToasts().some((t) => t.text.includes("outras páginas"));

let off: () => void;
let rev = 1;
beforeEach(() => {
  rev = 1;
  setPrefs({ language: "pt-BR" });
  resetMarkupForTests();
  resetHistoryForTests();
  resetToastsForTests();
  useFileUi.setState({ dialog: null, changed: {} });
  useDocs.setState({ docs: [tiff, other], activeId: 5 });
  useUi.setState({ page: null });
  invoke.mockReset().mockImplementation(async (cmd, args) => {
    const a = args as unknown as Args;
    if (cmd === "duplicate") return { ...tiff, id: 8, path: "", name: "cópia", dirty: true };
    if (cmd === "save") return { type: "needsExport" };
    const base = useDocs.getState().docs.find((d) => d.id === a?.id) ?? { ...tiff, id: a?.id };
    if (cmd === "save_as") return { ...base, path: a.dest, name: "n.png", format: "png", dirty: false, rev: ++rev };
    if (["apply_op", "undo", "export"].includes(cmd)) return { ...base, rev: ++rev };
    return null;
  });
  off = registerFileCommands();
  addAnnotation(5, rect("a"));
  useUi.setState({ page: 2 });
  addAnnotation(5, rect("b"));
  addAnnotation(5, rect("c"));
});
afterEach(() => off());

describe("fronteira com o Rust", () => {
  it("a cópia achatada (PDF, Imprimir) manda cada anotação com a sua página", async () => {
    await flattenedCopy(5, "cópia");
    expect(composites()).toEqual([[8, "a", 0], [8, "bc", 2]]);
    expect(ids(5)).toEqual(["a", "b", "c"]);
  });

  it("achatar leva só a página pedida, e desfazer a devolve", async () => {
    expect(await flattenAnnotations(5, 2)).toBe(true);
    expect(composites()).toEqual([[5, "bc", 2]]);
    expect(ids(5)).toEqual(["a"]);
    expect(await flattenAnnotations(5, 1)).toBe(false);
    await undo(5);
    expect(ids(5)).toEqual(["a", "b", "c"]);
  });

  it("anotação criada enquanto o achatamento roda não se perde", async () => {
    let go!: () => void;
    const reply = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "apply_op") await new Promise<void>((r) => (go = r));
      return reply(cmd, args);
    });
    const done = flattenAnnotations(5, 2);
    await vi.waitFor(() => expect(go).toBeTypeOf("function"));
    addAnnotation(5, rect("nova"));
    go();
    await done;
    expect(ids(5)).toEqual(["a", "nova"]);
  });
});

describe("gravar uma página não consome as anotações das outras", () => {
  it("Exportar grava a página pedida; as outras continuam editáveis, com aviso", async () => {
    await exportDoc(5, "/f/x.png", opts(2));
    expect(composites()).toEqual([[5, "bc", 2]]);
    expect(calls("export")[0].opts).toMatchObject({ frame: 2 });
    expect(ids(5)).toEqual(["a"]);
    expect(hasUnsaved(useDocs.getState().docs[0])).toBe(true);
    expect(pendingWarning()).toBe(true);
  });

  it("sem página (Exportar Selecionadas), vale a primeira", async () => {
    await exportDoc(5, "/f/x.png", opts());
    expect(composites()).toEqual([[5, "a", 0]]);
    expect(ids(5)).toEqual(["b", "c"]);
    expect(pendingWarning()).toBe(true);
  });

  it("sem nada pendente não avisa", async () => {
    await exportDoc(6, "/f/x.png", opts());
    expect(composites()).toEqual([]);
    expect(pendingWarning()).toBe(false);
  });

  it("Salvar Como grava a página exibida e o documento não fica limpo", async () => {
    dialog.save.mockResolvedValue("/f/n.png");
    await saveAsActive();
    expect(composites()).toEqual([[5, "bc", 2]]);
    expect(calls("save_as")[0].opts).toMatchObject({ frame: 2 });
    expect(ids(5)).toEqual(["a"]);
    expect(hasUnsaved(useDocs.getState().docs[0])).toBe(true);
    expect(pendingWarning()).toBe(true);
  });

  it("já achatada em outra página: o Rust mantém o documento com alterações, e o aviso aparece", async () => {
    const reply = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (cmd, args) => {
      const r = await reply(cmd, args);
      return cmd === "save_as" ? { ...(r as DocInfo), dirty: true } : r;
    });
    useDocs.getState().setActive(6);
    dialog.save.mockResolvedValue("/f/n.png");
    await saveAsActive();
    expect(pendingWarning()).toBe(true);
  });

  it("Salvar do que não dá para regravar abre o Exportar sem achatar (cancelar não muda nada)", async () => {
    expect(await saveDoc(tiff)).toBe(false);
    expect(useFileUi.getState().dialog).toEqual({ kind: "export", id: 5, mode: "save" });
    expect(composites()).toEqual([]);
    expect(ids(5)).toEqual(["a", "b", "c"]);
  });

  it("Duplicar leva as anotações, editáveis e na página delas; exportar a cópia só consome as gravadas", async () => {
    await duplicateActive();
    expect(composites()).toEqual([]);
    expect(getItems(8)).toEqual(getItems(5));
    expect(ids(5)).toEqual(["a", "b", "c"]);
    await exportDoc(8, "/f/x.png", opts());
    expect(ids(8)).toEqual(["b", "c"]);
    expect(hasUnsaved(useDocs.getState().docs.find((d) => d.id === 8)!)).toBe(true);
  });

  it("Copiar usa a página exibida, com as anotações dela", async () => {
    await copySelection();
    expect(calls("copy_image")).toEqual([{ id: 5, mask: null, png: [..."bc"].map((c) => c.charCodeAt(0)), frame: 2 }]);
    useUi.setState({ page: 1 });
    await copySelection();
    expect(calls("copy_region")).toEqual([{ id: 5, mask: null, frame: 1 }]);
  });
});

describe("página e seleção", () => {
  it("voltar ao documento em outra página não deixa selecionada uma anotação invisível", () => {
    expect(getSelected(5)).toEqual(["c"]);
    useDocs.getState().setActive(6);
    useUi.getState().setPage(null);
    useDocs.getState().setActive(5);
    expect(getSelected(5)).toEqual([]);
    deleteSelected(5);
    expect(ids(5)).toEqual(["a", "b", "c"]);
  });

  it("a página exibida existe no documento: fechar, reverter ou restaurar com menos páginas volta à primeira", async () => {
    useDocs.getState().update({ ...tiff, frames: 1, rev: 9 });
    expect(useUi.getState().page).toBeNull();
    useDocs.getState().update({ ...tiff, frames: 3, rev: 10 });
    useUi.getState().setPage(2);
    await useDocs.getState().close(5);
    expect(useDocs.getState().activeId).toBe(6);
    expect(useUi.getState().page).toBeNull();
  });

  it("páginas são pelos atrasos, como no Rust: animação não tem páginas", () => {
    expect(hasPages(tiff)).toBe(true);
    expect(hasPages({ ...tiff, format: "gif", delaysMs: [100, 100, 100] })).toBe(false);
    expect(hasPages({ ...tiff, format: "gif" })).toBe(true);
    expect(hasPages({ ...tiff, frames: 1 })).toBe(false);
  });
});
