// Imprimir e Exportar como PDF (Lote 11).
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo, PrintOptions, PrintPreview } from "../ipc/types";

const ipc = vi.hoisted(() => ({
  duplicate: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  applyOp: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  undo: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  closeDocument: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => {}),
  thumbnail: vi.fn(async () => ({ width: 1, height: 1, data: new Uint8ClampedArray(4) })),
  printPreview: vi.fn<(ids: number[], opts: unknown) => Promise<unknown>>(),
  printNative: vi.fn<(...a: unknown[]) => Promise<boolean>>(async () => true),
  exportPdf: vi.fn<(...a: unknown[]) => Promise<void>>(async () => {}),
  pathExists: vi.fn<(p: string) => Promise<boolean>>(async () => false),
}));
vi.mock("../ipc/commands", () => ipc);
const dialog = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn<(...a: unknown[]) => Promise<string | null>>() }));
vi.mock("@tauri-apps/plugin-dialog", () => dialog);
vi.mock("../markup/render", async (orig) => ({
  ...(await orig<typeof import("../markup/render")>()),
  flattenToPng: vi.fn(async () => new Uint8Array([1, 2, 3])),
}));

import { getToasts, resetToastsForTests } from "../chrome/notify";
import { Slot } from "../lib/slots";
import { addAnnotation } from "../markup/actions";
import { flattenAnnotations } from "../markup/flatten";
import { resetHistoryForTests, undo } from "../markup/history";
import type { Annotation } from "../markup/model";
import { flattenToPng } from "../markup/render";
import { getItems, useMarkup } from "../markup/store";
import { isEnabled, runCommand } from "../shortcuts/commands";
import { useDocs } from "../store/docs";
import { setPrefs } from "../store/prefs";
import { useUi } from "../store/ui";
import { defaultPaper, resetPrintOptionsForTests } from "./PrintDialog";
import { closePrint, exportPdf, printDocs, usePrintUi } from "./print";
import "./register";

const doc = (id: number, name: string, extra: Partial<DocInfo> = {}): DocInfo => ({
  id, path: `/f/${name}`, name, format: "png", width: 60, height: 30, frames: 1, delaysMs: [], plays: 0,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 1, error: null, ...extra,
});
const a = doc(1, "Ação 1.png");
const b = doc(2, "b.jpg", { format: "jpeg" });
const broken = doc(3, "ruim.png", { error: "corrupt" });
const rect = { id: "r1", kind: "rect", x: 0, y: 0, w: 2, h: 2 } as unknown as Annotation;

const cell = { x: 18, y: 18, w: 564, h: 806 };
const item = (id: number) => ({ id, frame: 0, rotated: true, rect: { x: 98, y: 18, w: 403, h: 806 }, clip: cell });
const preview = (ids: number[]): PrintPreview => ({ paperW: 600, paperH: 842, pages: ids.map((id) => [item(id)]) });

beforeEach(() => {
  vi.clearAllMocks();
  setPrefs({ language: "pt-BR" });
  resetToastsForTests();
  resetPrintOptionsForTests();
  useDocs.setState({ docs: [a, b, broken], activeId: 1 });
  useMarkup.setState({ docs: {}, selected: {} });
  resetHistoryForTests();
  ipc.printPreview.mockImplementation(async (ids) => preview(ids));
  ipc.duplicate.mockImplementation(async () => doc(8, "cópia", { path: "", dirty: true }));
  ipc.applyOp.mockImplementation(async (id) => doc(id as number, "cópia", { path: "", rev: 2 }));
});
afterEach(async () => {
  cleanup();
  closePrint();
  await act(async () => {});
});

const openDialog = async (ids?: number[]) => {
  render(<Slot name="above-content" props={{}} />);
  await act(async () => printDocs(ids));
  await screen.findByRole("dialog");
};
const lastOpts = () => ipc.printPreview.mock.lastCall![1] as PrintOptions;
const print = () => act(async () => fireEvent.click(screen.getByTestId("print-ok")));

describe("comandos", () => {
  it("Imprimir e Exportar como PDF habilitam com documento exibível", () => {
    expect(isEnabled("file.print") && isEnabled("file.exportPdf")).toBe(true);
    useDocs.setState({ activeId: 3 });
    expect(isEnabled("file.print") || isEnabled("file.exportPdf")).toBe(false);
  });

  it("Imprimir abre o diálogo do documento ativo; com lista, só os exibíveis, na ordem", () => {
    runCommand("file.print");
    expect(usePrintUi.getState().ids).toEqual([1]);
    printDocs([2, 3, 1, 99]);
    expect(usePrintUi.getState().ids).toEqual([2, 1]);
    closePrint();
    printDocs([3]);
    expect(usePrintUi.getState().ids).toBeNull();
  });

  it("papel padrão pelo país", () => {
    expect([defaultPaper("en-US"), defaultPaper("pt-BR"), defaultPaper("en")]).toEqual(["na_letter", "iso_a4", "iso_a4"]);
  });
});

describe("diálogo Imprimir", () => {
  it("cada opção vai para a prévia e para a impressão", async () => {
    await openDialog();
    await screen.findByTestId("print-cell");
    expect(lastOpts()).toMatchObject({ copies: 1, scalePercent: null, fit: "whole", autoRotate: true, perPage: 1, orientation: "portrait" });
    const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
    change("Cópias", "3");
    change("Papel", "iso_a5");
    change("Orientação", "landscape");
    change("Imagens por página", "4");
    fireEvent.click(screen.getByLabelText("Girar automaticamente"));
    fireEvent.click(screen.getByLabelText("Preencher o papel"));
    const want = { copies: 3, paper: "iso_a5", orientation: "landscape", perPage: 4, autoRotate: false, fit: "fill", scalePercent: null };
    await waitFor(() => expect(lastOpts()).toMatchObject(want));
    await print();
    expect(ipc.printNative).toHaveBeenCalledWith([1], expect.objectContaining(want), "Ação 1.png");
    expect(usePrintUi.getState().ids).toBeNull();
    expect(getToasts().map((t) => t.text)).toContain("Impressão enviada.");
    // A próxima impressão lembra as opções, menos as cópias.
    await act(async () => printDocs([2]));
    await waitFor(() => expect(lastOpts()).toMatchObject({ ...want, copies: 1 }));
  });

  it("escala em % desliga o ajuste ao papel e ignora valores inválidos", async () => {
    await openDialog();
    fireEvent.change(screen.getByLabelText("Escala (%)"), { target: { value: "50" } });
    expect(lastOpts().scalePercent).toBe(50);
    expect(screen.getByLabelText("Preencher o papel")).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByLabelText("Escala (%)"), { target: { value: "" } });
    expect(lastOpts().scalePercent).toBe(50);
    fireEvent.change(screen.getByLabelText("Escala (%)"), { target: { value: "99999" } });
    expect(lastOpts().scalePercent).toBe(1000);
    fireEvent.click(screen.getByLabelText("Ajustar ao papel"));
    expect(lastOpts().scalePercent).toBeNull();
  });

  it("mostra as páginas e navega por elas; a imagem girada é desenhada de lado", async () => {
    await openDialog([1, 2]);
    expect(screen.getByRole("heading").textContent).toBe("Imprimir 2 imagens");
    await waitFor(() => expect(screen.getByTestId("print-page").textContent).toBe("Página 1 de 2"));
    const canvas = screen.getByTestId("print-cell").querySelector("canvas")!;
    expect(canvas.style.transform).toContain("rotate(90deg)");
    expect(screen.getByLabelText("Página anterior")).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByLabelText("Próxima página"));
    expect(screen.getByTestId("print-page").textContent).toBe("Página 2 de 2");
    await print();
    expect(ipc.printNative).toHaveBeenCalledWith([1, 2], expect.anything(), "2 imagens");
  });

  it("cancelar no diálogo do sistema volta para as opções", async () => {
    ipc.printNative.mockResolvedValueOnce(false);
    await openDialog();
    await print();
    expect(usePrintUi.getState().ids).toEqual([1]);
    expect(screen.getByTestId("print-ok")).toHaveProperty("disabled", false);
    expect(getToasts()).toEqual([]);
  });

  it("enquanto imprime, Esc não fecha (as cópias ainda estão em uso)", async () => {
    let finish!: (v: boolean) => void;
    ipc.printNative.mockImplementationOnce(() => new Promise((r) => (finish = r)));
    await openDialog();
    await print();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(usePrintUi.getState().ids).toEqual([1]);
    await act(async () => finish(true));
    expect(usePrintUi.getState().ids).toBeNull();
  });

  it("erro na impressão avisa e mantém o diálogo", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    ipc.printNative.mockRejectedValueOnce({ code: "io", message: "x" });
    await openDialog();
    await print();
    expect(getToasts()).toHaveLength(1);
    expect(usePrintUi.getState().ids).toEqual([1]);
  });
});

describe("anotações não achatadas", () => {
  beforeEach(() => useMarkup.setState({ docs: { 1: [rect] }, selected: {} }));

  it("Imprimir usa uma cópia achatada, fechada no fim; o original não muda", async () => {
    await openDialog([2, 1]);
    await waitFor(() => expect(ipc.printPreview).toHaveBeenCalledWith([2, 8], expect.anything()));
    expect(ipc.duplicate).toHaveBeenCalledTimes(1);
    await print();
    expect(ipc.printNative).toHaveBeenCalledWith([2, 8], expect.anything(), "2 imagens");
    await waitFor(() => expect(ipc.closeDocument).toHaveBeenCalledWith(8));
    expect(ipc.applyOp.mock.calls.every(([id]) => id === 8)).toBe(true);
    expect(getItems(1)).toEqual([rect]);
  });

  it("sem Mostrar marcações, imprime o próprio documento", async () => {
    await openDialog();
    await act(async () => fireEvent.click(screen.getByLabelText("Mostrar marcações")));
    await print();
    expect(ipc.printNative).toHaveBeenCalledWith([1], expect.anything(), "Ação 1.png");
  });

  it("fechar o diálogo fecha a cópia, mesmo que ela fique pronta depois", async () => {
    let ready!: (d: DocInfo) => void;
    ipc.duplicate.mockImplementationOnce(() => new Promise((r) => (ready = r as typeof ready)));
    await openDialog();
    await act(async () => closePrint());
    await act(async () => ready(doc(8, "cópia", { path: "" })));
    await waitFor(() => expect(ipc.closeDocument).toHaveBeenCalledWith(8));
  });

  it("Exportar como PDF achata numa cópia e a fecha, até se falhar", async () => {
    dialog.save.mockResolvedValue("/f/x.pdf");
    ipc.exportPdf.mockRejectedValueOnce(new Error("disco cheio"));
    await expect(exportPdf([1])).rejects.toThrow("disco cheio");
    expect(ipc.exportPdf).toHaveBeenCalledWith([8], "/f/x.pdf");
    expect(ipc.closeDocument).toHaveBeenCalledWith(8);
    expect(getItems(1)).toEqual([rect]);
  });
});

describe("anotações em TIFF de várias páginas", () => {
  const tiff = doc(5, "t.tiff", { format: "tiff", frames: 3, writable: false });
  const gif = doc(6, "g.gif", { format: "gif", frames: 3 });
  const frames = () => ipc.applyOp.mock.calls.map(([id, op]) => [id, (op as { data: { frame?: number } }).data.frame]);

  beforeEach(() => {
    useDocs.setState({ docs: [tiff, gif], activeId: 5 });
    useUi.setState({ page: null });
  });

  it("cada uma sai só na página em que foi feita", async () => {
    addAnnotation(5, { ...rect, id: "a" });
    useUi.setState({ page: 2 });
    addAnnotation(5, { ...rect, id: "b" });
    addAnnotation(5, { ...rect, id: "c" });
    useUi.setState({ page: 1 });
    dialog.save.mockResolvedValue("/f/x.pdf");
    await exportPdf([5]);
    expect(frames()).toEqual([[8, 0], [8, 2]]);
    expect(vi.mocked(flattenToPng).mock.calls.map(([items]) => items.map((i) => i.id))).toEqual([["a"], ["b", "c"]]);
    expect(ipc.exportPdf).toHaveBeenCalledWith([8], "/f/x.pdf");
    expect(getItems(5)).toHaveLength(3);
  });

  it("a impressão usa a mesma cópia por página", async () => {
    useUi.setState({ page: 1 });
    addAnnotation(5, { ...rect, id: "a" });
    await openDialog([5]);
    await waitFor(() => expect(ipc.printPreview).toHaveBeenCalledWith([8], expect.anything()));
    expect(frames()).toEqual([[8, 1]]);
  });

  it("numa animação a anotação vale para todos os quadros", async () => {
    useDocs.setState({ activeId: 6 });
    useUi.setState({ page: 2 });
    addAnnotation(6, { ...rect, id: "a" });
    dialog.save.mockResolvedValue("/f/x.pdf");
    await exportPdf([6]);
    expect(frames()).toEqual([[8, undefined]]);
  });

  it("se uma página falha, a cópia é fechada e nada é exportado", async () => {
    addAnnotation(5, { ...rect, id: "a" });
    useUi.setState({ page: 2 });
    addAnnotation(5, { ...rect, id: "b" });
    ipc.applyOp.mockImplementationOnce(async () => doc(8, "cópia")).mockRejectedValueOnce(new Error("x"));
    dialog.save.mockResolvedValue("/f/x.pdf");
    await expect(exportPdf([5])).rejects.toThrow("x");
    expect(ipc.closeDocument).toHaveBeenCalledWith(8);
    expect(ipc.exportPdf).not.toHaveBeenCalled();
  });

  it("Salvar/Exportar achata por página, e cada passo desfaz só as anotações da sua página", async () => {
    addAnnotation(5, { ...rect, id: "a" });
    useUi.setState({ page: 2 });
    addAnnotation(5, { ...rect, id: "b" });
    await flattenAnnotations(5);
    expect(frames()).toEqual([[5, 0], [5, 2]]);
    expect(getItems(5)).toEqual([]);
    ipc.undo.mockResolvedValue(tiff);
    await undo(5);
    expect(getItems(5).map((i) => i.id)).toEqual(["b"]);
    await undo(5);
    expect(getItems(5).map((i) => i.id)).toEqual(["a", "b"]);
  });
});

describe("Exportar como PDF", () => {
  it("sugere o nome do documento e exporta as imagens na ordem", async () => {
    dialog.save.mockResolvedValue("/g/álbum.PDF");
    await exportPdf([2, 1]);
    expect(dialog.save.mock.calls[0][0]).toMatchObject({ defaultPath: "/f/b.pdf" });
    expect(ipc.exportPdf).toHaveBeenCalledWith([2, 1], "/g/álbum.PDF");
    expect(getToasts().map((t) => t.text)).toEqual(["PDF “álbum.PDF” exportado."]);
  });

  it("cancelado não faz nada", async () => {
    dialog.save.mockResolvedValue(null);
    await exportPdf();
    expect(ipc.exportPdf).not.toHaveBeenCalled();
  });

  it("acrescenta .pdf e, se esse arquivo já existir, pergunta de novo em vez de sobrescrever", async () => {
    dialog.save.mockResolvedValueOnce("/f/foto.png").mockResolvedValueOnce("/f/novo.pdf");
    ipc.pathExists.mockImplementation(async (p) => p === "/f/foto.png.pdf");
    await exportPdf();
    expect(dialog.save.mock.calls[1][0]).toMatchObject({ defaultPath: "/f/foto.png.pdf" });
    expect(ipc.exportPdf).toHaveBeenCalledWith([1], "/f/novo.pdf");
    ipc.pathExists.mockResolvedValue(false);
    dialog.save.mockResolvedValueOnce("/f/livre");
    await exportPdf();
    expect(ipc.exportPdf).toHaveBeenLastCalledWith([1], "/f/livre.pdf");
  });
});
