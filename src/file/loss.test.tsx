// O que o formato de destino vai descartar é dito antes de gravar: páginas, anotações de outras
// páginas e metadados. E o TIFF de várias páginas é gravado inteiro. Da ação até o `invoke`.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo, ExportOptions } from "../ipc/types";

type Args = Record<string, unknown> & { id: number };
const invoke = vi.hoisted(() => vi.fn<(cmd: string, args: never) => Promise<unknown>>(async () => null));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onCloseRequested: vi.fn(async () => () => {}) }) }));
const dialog = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn<() => Promise<string | null>>() }));
vi.mock("@tauri-apps/plugin-dialog", () => dialog);
vi.mock("../markup/render", async (orig) => ({
  ...(await orig<typeof import("../markup/render")>()),
  flattenToPng: vi.fn(async () => new Uint8Array([1])),
}));

import { getToasts, resetToastsForTests } from "../chrome/notify";
import { saveAsActive } from "../finder/actions";
import "../finder/register";
import { answerConfirm, resetFinderUiForTests, useFinderUi } from "../finder/store";
import { reportMetaNotes } from "../inspector/notes";
import { Slot } from "../lib/slots";
import { resetHistoryForTests } from "../markup/history";
import { DEFAULT_STYLE, type Annotation } from "../markup/model";
import { getItems, resetMarkupForTests, useMarkup } from "../markup/store";
import { useDocs } from "../store/docs";
import { setPrefs } from "../store/prefs";
import { useUi } from "../store/ui";
import { ExportDialog, ExportSelectedDialog } from "./ExportDialog";
import { saveDoc } from "./fileActions";
import { registerFileCommands } from "./register";

const tiff: DocInfo = {
  id: 5, path: "/f/t.tiff", name: "t.tiff", format: "tiff", width: 40, height: 30, frames: 3,
  pageSizes: [[40, 30], [60, 80], [10, 12]],
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 1, error: null,
};
const avif: DocInfo = { ...tiff, id: 6, path: "/f/a.avif", name: "a.avif", format: "avif", frames: 1, pageSizes: [] };
const rect = (id: string, page?: number): Annotation =>
  ({ id, kind: "rect", geom: { x: 0, y: 0, w: 2, h: 2 }, style: DEFAULT_STYLE, ...(page ? { page } : {}) }) as Annotation;
const calls = (cmd: string) => invoke.mock.calls.filter(([c]) => c === cmd).map(([, a]) => a as unknown as Args);
const optsOf = (cmd: string) => calls(cmd)[0].opts as ExportOptions;
const pages = () => calls("apply_op").map((a) => (a.op as { data: { frame?: number } }).data.frame);
const asked = () => useFinderUi.getState().confirm;
/** Responde à confirmação quando ela aparecer e devolve o que ela dizia. */
async function answer(ok: boolean): Promise<string[]> {
  await waitFor(() => expect(asked()).not.toBeNull());
  const said = [...asked()!.details!];
  answerConfirm(ok);
  return said;
}

let carried = { exif: false, text: false };
let off: () => void;
let rev = 1;
beforeEach(() => {
  rev = 1;
  carried = { exif: false, text: false };
  setPrefs({ language: "pt-BR" });
  resetMarkupForTests();
  resetHistoryForTests();
  resetToastsForTests();
  resetFinderUiForTests();
  useDocs.setState({ docs: [tiff, avif], activeId: 5 });
  useUi.setState({ page: 1 });
  dialog.save.mockReset();
  invoke.mockReset().mockImplementation(async (cmd, args) => {
    const a = args as unknown as Args;
    const base = useDocs.getState().docs.find((d) => d.id === a?.id);
    if (cmd === "metadata") return { carried };
    if (cmd === "save") return { type: "saved", data: { ...base, rev: ++rev } };
    if (cmd === "save_as") return { ...base, path: a.dest, name: "n", rev: ++rev };
    if (cmd === "apply_op" || cmd === "export") return { ...base, rev: ++rev };
    if (cmd === "take_meta_notes") return [];
    if (cmd === "path_exists") return false;
    if (cmd === "estimate_size") return 10;
    return null;
  });
  off = registerFileCommands();
  useMarkup.getState().setItems(5, [rect("a"), rect("b", 1), rect("c", 2)]);
});
afterEach(() => {
  off();
  cleanup();
});

describe("TIFF de várias páginas", () => {
  it("Salvar achata as anotações de todas as páginas e grava no próprio arquivo", async () => {
    expect(await saveDoc(tiff)).toBe(true);
    expect(pages()).toEqual([0, 1, 2]);
    expect(getItems(5)).toEqual([]);
    expect(asked()).toBeNull();
    expect(getToasts().some((t) => t.text.includes("outras páginas"))).toBe(false);
  });

  it("Salvar Como TIFF grava todas, sem pergunta nem aviso de páginas", async () => {
    dialog.save.mockResolvedValue("/f/n.tif");
    await saveAsActive();
    expect(optsOf("save_as")).toMatchObject({ format: "tiff", allPages: true });
    expect(pages()).toEqual([0, 1, 2]);
    expect(getToasts().some((t) => t.text.includes("outras páginas"))).toBe(false);
  });

  it("Exportar TIFF grava todas por padrão; desmarcando, só a exibida", async () => {
    const { unmount } = render(<ExportDialog doc={tiff} mode="export" onClose={() => {}} />);
    expect(screen.queryByTestId("export-page")).toBeNull();
    fireEvent.click(screen.getByTestId("export-ok"));
    await waitFor(() => expect(calls("export")).toHaveLength(1));
    expect(optsOf("export")).toMatchObject({ format: "tiff", allPages: true });
    unmount();
    invoke.mockClear();
    render(<ExportDialog doc={tiff} mode="export" onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText("Todas as páginas"));
    expect(screen.getByTestId("export-page").textContent).toContain("2 de 3");
    fireEvent.click(screen.getByTestId("export-ok"));
    await waitFor(() => expect(calls("export")).toHaveLength(1));
    expect(optsOf("export")).toMatchObject({ allPages: false, frame: 1 });
  });

  it("Exportar Selecionadas: TIFF leva todas as páginas, com o lado maior em cada uma", async () => {
    render(<ExportSelectedDialog onClose={() => {}} />);
    expect(screen.getByTestId("export-pages-lost").textContent).toContain("primeira página");
    fireEvent.change(screen.getByRole("combobox", { name: /Formato/ }), { target: { value: "tiff" } });
    expect(screen.queryByTestId("export-pages-lost")).toBeNull();
    fireEvent.change(screen.getByLabelText(/lado maior/), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Exportar" }));
    await waitFor(() => expect(calls("export")).toHaveLength(2));
    expect(calls("export")[0].opts).toMatchObject({ allPages: true, resize: [20, 20] });
    expect(calls("export")[1].opts).not.toHaveProperty("allPages");
  });
});

describe("Salvar Como", () => {
  it("grava a página de quando foi pedido, mesmo que ela mude com o diálogo aberto", async () => {
    dialog.save.mockImplementation(async () => {
      useUi.setState({ page: 2 });
      return "/f/n.png";
    });
    const done = saveAsActive();
    await answer(true);
    await done;
    expect(optsOf("save_as")).toMatchObject({ frame: 1 });
    expect(pages()).toEqual([1]);
  });

  it("formato de uma página: diz o que fica de fora antes de gravar; Cancelar não muda nada", async () => {
    dialog.save.mockResolvedValue("/f/n.png");
    const done = saveAsActive();
    const said = await answer(false);
    await done;
    expect(said).toHaveLength(2);
    expect(said[0]).toContain("página 2 de 3");
    expect(said[1]).toContain("anotações");
    expect(calls("save_as")).toEqual([]);
    expect(pages()).toEqual([]);
    expect(getItems(5)).toHaveLength(3);
  });

  it("diz os metadados que o formato não guarda", async () => {
    useDocs.setState({ activeId: 6 });
    carried = { exif: true, text: true };
    dialog.save.mockResolvedValue("/f/n.bmp");
    let done = saveAsActive();
    const said = await answer(false);
    await done;
    expect(said).toHaveLength(2);
    expect(said[0]).toContain("EXIF");
    expect(said[1]).toContain("XMP");
    // AVIF guarda o EXIF; PNG guarda tudo.
    dialog.save.mockResolvedValue("/f/n.avif");
    done = saveAsActive();
    expect(await answer(true)).toEqual([said[1]]);
    await done;
    expect(calls("save_as")).toHaveLength(1);
    dialog.save.mockResolvedValue("/f/n.png");
    await saveAsActive();
    expect(calls("save_as")).toHaveLength(2);
  });

  it("a confirmação mostra os itens e o nome do documento", async () => {
    render(<Slot name="above-content" props={{}} />);
    dialog.save.mockResolvedValue("/f/n.png");
    const done = saveAsActive();
    const box = await screen.findByRole("alertdialog");
    expect(box.textContent).toContain("t.tiff");
    expect(box.querySelectorAll("li")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    await done;
    expect(calls("save_as")).toEqual([]);
  });
});

describe("Salvar e Exportar", () => {
  it("Salvar num formato que não guarda o XMP do arquivo pergunta antes", async () => {
    carried = { exif: true, text: true };
    const done = saveDoc(avif);
    expect((await answer(false))[0]).toContain("XMP");
    expect(await done).toBe(false);
    expect(calls("save")).toEqual([]);
    carried = { exif: true, text: false };
    expect(await saveDoc(avif)).toBe(true);
  });

  it("Exportar mostra no diálogo o que o formato não guarda, e some com Remover metadados", async () => {
    carried = { exif: true, text: true };
    render(<ExportDialog doc={avif} mode="export" onClose={() => {}} />);
    const losses = await screen.findByTestId("export-losses");
    expect(losses.textContent).toContain("XMP");
    fireEvent.click(screen.getByLabelText(/Remover metadados/));
    expect(screen.queryByTestId("export-losses")).toBeNull();
  });

  it("os avisos depois de gravar dizem de que documento são", async () => {
    invoke.mockImplementation(async () => ["exifTooBig", "exifDropped"]);
    await reportMetaNotes(6);
    const texts = getToasts().map((t) => t.text);
    expect(texts).toHaveLength(2);
    expect(texts.every((t) => t.startsWith("a.avif: "))).toBe(true);
    expect(texts[0]).toContain("64 KB");
  });
});
