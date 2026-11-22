import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo } from "../ipc/types";

const ipc = vi.hoisted(() => ({
  save: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  exportDoc: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  estimateSize: vi.fn(async () => 2048),
  pathExists: vi.fn(async () => false),
  heicEncoderAvailable: vi.fn(async () => true),
  documentDpi: vi.fn<(...a: unknown[]) => Promise<number | null>>(async () => null),
  exportTagged: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
}));
vi.mock("../ipc/commands", () => ipc);
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

import { getToasts, resetToastsForTests } from "../chrome/notify";
import { useDocs } from "../store/docs";
import { setPrefs } from "../store/prefs";
import { addKeyword, getPendingKeywords, resetKeywordsForTests } from "../inspector/keywords";
import { registerBeforeSave } from "./beforeSave";
import { saveDoc, useFileUi } from "./fileActions";
import { ExportDialog, ExportSelectedDialog } from "./ExportDialog";
import { resetHeicProbeForTests } from "./estimate";

const doc: DocInfo = {
  id: 1, path: "/fotos/Ação 1.jpg", name: "Ação 1.jpg", format: "jpeg", width: 40, height: 20, frames: 1,
  writable: true, dirty: true, canUndo: true, canRedo: false, rev: 1, error: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  // O addRecent do Exportar emite prefs; fixa o idioma para o i18n não voltar ao do sistema (en).
  setPrefs({ language: "pt-BR" });
  resetKeywordsForTests();
  resetHeicProbeForTests();
  useDocs.setState({ docs: [doc], activeId: 1 });
  useFileUi.setState({ dialog: null, changed: {} });
});
afterEach(cleanup);

describe("saveDoc", () => {
  it("achata antes (beforeSave), grava as palavras-chave pendentes e as limpa", async () => {
    const order: string[] = [];
    const off = registerBeforeSave(async () => void order.push("before"));
    ipc.save.mockImplementation(async () => {
      order.push("save");
      return { type: "saved", data: { ...doc, dirty: false, rev: 2 } };
    });
    addKeyword(1, "praia");
    expect(await saveDoc(doc)).toBe(true);
    off();
    expect(order).toEqual(["before", "save"]);
    expect(ipc.save).toHaveBeenCalledWith(1, ["praia"]);
    expect(getPendingKeywords(1)).toBeNull();
    expect(useDocs.getState().docs[0].dirty).toBe(false);
  });

  it.each([
    ["tiff", null],
    ["avif", ["praia"]],
    ["bmp", ["praia"]],
  ] as const)("palavras-chave salvas em %s saem da fila só se o formato as grava", async (format, pending) => {
    ipc.save.mockResolvedValue({ type: "saved", data: { ...doc, format, dirty: false, rev: 2 } });
    addKeyword(1, "praia");
    expect(await saveDoc({ ...doc, format })).toBe(true);
    expect(getPendingKeywords(1)).toEqual(pending);
  });

  it("formato que não regrava abre Exportar em modo Salvar", async () => {
    ipc.save.mockResolvedValue({ type: "needsExport" });
    expect(await saveDoc(doc)).toBe(false);
    expect(useFileUi.getState().dialog).toEqual({ kind: "export", id: 1, mode: "save" });
  });
});

describe("ExportDialog", () => {
  it("exporta para pasta/nome digitados, com extensão do formato", async () => {
    ipc.exportDoc.mockResolvedValue(doc);
    const onClose = vi.fn();
    render(createElement(ExportDialog, { doc, mode: "export", onClose }));
    expect((screen.getByTestId("export-name") as HTMLInputElement).value).toBe("Ação 1.jpg");
    expect((screen.getByTestId("export-folder") as HTMLInputElement).value).toBe("/fotos");
    fireEvent.change(screen.getByLabelText("Formato"), { target: { value: "webp" } });
    expect((screen.getByTestId("export-name") as HTMLInputElement).value).toBe("Ação 1.webp");
    await act(async () => fireEvent.click(screen.getByTestId("export-ok")));
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(ipc.exportDoc).toHaveBeenCalledWith(1, "/fotos/Ação 1.webp", expect.objectContaining({ format: "webp" }), null);
  });

  it("perfil de saída: mantém o da imagem por padrão e converte para sRGB quando escolhido", async () => {
    ipc.exportDoc.mockResolvedValue(doc);
    render(createElement(ExportDialog, { doc, mode: "export", onClose: () => {} }));
    const profile = screen.getByLabelText("Perfil de cor") as HTMLSelectElement;
    expect(profile.value).toBe("keep");
    fireEvent.change(profile, { target: { value: "srgb" } });
    await act(async () => fireEvent.click(screen.getByTestId("export-ok")));
    expect(ipc.exportDoc).toHaveBeenCalledWith(1, "/fotos/Ação 1.jpg", expect.objectContaining({ colorProfile: "srgb" }), null);
  });

  it("AVIF e EXR não levam perfil: só manter ou sRGB, e a troca de formato desfaz outra escolha", async () => {
    ipc.exportDoc.mockResolvedValue(doc);
    render(createElement(ExportDialog, { doc, mode: "export", onClose: () => {} }));
    const profile = screen.getByLabelText("Perfil de cor") as HTMLSelectElement;
    fireEvent.change(profile, { target: { value: "adobe-rgb" } });
    for (const format of ["avif", "exr"]) {
      fireEvent.change(screen.getByLabelText("Formato"), { target: { value: format } });
      expect([...profile.options].map((o) => o.value)).toEqual(["keep", "srgb"]);
      expect(profile.value).toBe("keep");
    }
    await act(async () => fireEvent.click(screen.getByTestId("export-ok")));
    expect(ipc.exportDoc).toHaveBeenCalledWith(1, "/fotos/Ação 1.exr", expect.objectContaining({ colorProfile: null }), null);
  });

  it("pergunta antes de substituir um arquivo existente", async () => {
    ipc.pathExists.mockResolvedValue(true);
    ipc.exportDoc.mockResolvedValue(doc);
    render(createElement(ExportDialog, { doc, mode: "export", onClose: () => {} }));
    await act(async () => fireEvent.click(screen.getByTestId("export-ok")));
    expect(ipc.exportDoc).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(await screen.findByText("Substituir")));
    expect(ipc.exportDoc).toHaveBeenCalledWith(1, "/fotos/Ação 1.jpg", expect.anything(), null);
  });

  it("oferece HEIC (com qualidade) e JPEG 2000 (sem perdas ou com qualidade)", async () => {
    ipc.exportDoc.mockResolvedValue(doc);
    ipc.pathExists.mockResolvedValue(false);
    const onClose = vi.fn();
    render(createElement(ExportDialog, { doc, mode: "export", onClose }));
    fireEvent.change(screen.getByLabelText("Formato"), { target: { value: "heic" } });
    expect((screen.getByTestId("export-name") as HTMLInputElement).value).toBe("Ação 1.heic");
    expect(screen.getByRole("slider")).toHaveProperty("value", "80");
    expect(screen.getByLabelText("Manter transparência (alfa)")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Formato"), { target: { value: "jp2" } });
    expect((screen.getByTestId("export-name") as HTMLInputElement).value).toBe("Ação 1.jp2");
    expect(screen.getByRole("slider")).toHaveProperty("value", "90");
    fireEvent.click(screen.getByLabelText("Sem perdas"));
    expect(screen.queryByRole("slider")).toBeNull();
    await act(async () => fireEvent.click(screen.getByTestId("export-ok")));
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(ipc.exportDoc).toHaveBeenCalledWith(
      1, "/fotos/Ação 1.jp2", expect.objectContaining({ format: "jp2", quality: null }), null,
    );
  });

  it("sem libkvazaar, HEIC some da lista, vira PNG e explica o que instalar", async () => {
    ipc.heicEncoderAvailable.mockResolvedValueOnce(false);
    render(createElement(ExportDialog, { doc: { ...doc, name: "a.heic", format: "heic" }, mode: "save", onClose: () => {} }));
    const select = screen.getByLabelText("Formato") as HTMLSelectElement;
    await vi.waitFor(() => expect(select.value).toBe("png"));
    expect([...select.options].map((o) => o.value)).not.toContain("heic");
    expect((screen.getByTestId("export-name") as HTMLInputElement).value).toBe("a.png");
    expect(screen.getByText(/instale a libkvazaar/)).toBeTruthy();
  });

  it("abre com o formato do arquivo HEIC/JPEG 2000", () => {
    render(createElement(ExportDialog, { doc: { ...doc, name: "a.jp2", format: "jp2" }, mode: "export", onClose: () => {} }));
    expect((screen.getByLabelText("Formato") as HTMLSelectElement).value).toBe("jp2");
  });

  it("mostra o tamanho estimado (debounce)", async () => {
    render(createElement(ExportDialog, { doc, mode: "export", onClose: () => {} }));
    expect(screen.getByTestId("export-estimate").textContent).toContain("Calculando");
    await vi.waitFor(() => expect(screen.getByTestId("export-estimate").textContent).toContain("2 KB"));
  });
});

describe("ExportDialog completo (Lote 11)", () => {
  const open = () => {
    ipc.exportDoc.mockResolvedValue(doc);
    ipc.pathExists.mockResolvedValue(false);
    render(createElement(ExportDialog, { doc, mode: "export", onClose: () => {} }));
  };
  const format = () => screen.getByLabelText("Formato") as HTMLSelectElement;
  const formats = () => [...format().options].map((o) => o.value);
  const choose = (f: string) => fireEvent.change(format(), { target: { value: f } });
  const ok = () => act(async () => fireEvent.click(screen.getByTestId("export-ok")));
  const sent = (dest: string, opts: object) =>
    expect(ipc.exportDoc).toHaveBeenCalledWith(1, dest, expect.objectContaining(opts), null);

  it("PDF sai sem perdas por padrão e aceita qualidade", async () => {
    open();
    choose("pdf");
    expect(screen.queryByRole("slider")).toBeNull();
    fireEvent.click(screen.getByLabelText("Sem perdas"));
    expect(screen.getByRole("slider")).toHaveProperty("value", "90");
    fireEvent.click(screen.getByLabelText("Sem perdas"));
    await ok();
    sent("/fotos/Ação 1.pdf", { format: "pdf", quality: null });
  });

  it("GIF, ICO, TGA e Photoshop só aparecem com Alt, que não chega à barra de menus", () => {
    open();
    expect(formats()).not.toContain("gif");
    const menu = vi.fn();
    window.addEventListener("keydown", menu);
    fireEvent.keyDown(document.body, { key: "Alt" });
    window.removeEventListener("keydown", menu);
    expect(menu).not.toHaveBeenCalled();
    expect(formats().slice(-4)).toEqual(["gif", "ico", "tga", "psd"]);
    choose("gif");
    expect((screen.getByTestId("export-name") as HTMLInputElement).value).toBe("Ação 1.gif");
    const profile = screen.getByLabelText("Perfil de cor") as HTMLSelectElement;
    expect([...profile.options].map((o) => o.value)).toEqual(["keep", "srgb"]);
  });

  it("Alt+clique no formato também mostra os extras", () => {
    open();
    fireEvent.pointerDown(format(), { altKey: false });
    expect(formats()).not.toContain("psd");
    fireEvent.pointerDown(format(), { altKey: true });
    expect(formats()).toContain("psd");
  });

  it("TIFF tem compressão e EXR tem half/float", async () => {
    open();
    expect(screen.queryByLabelText("Compressão")).toBeNull();
    choose("tiff");
    fireEvent.change(screen.getByLabelText("Compressão"), { target: { value: "lzw" } });
    await ok();
    sent("/fotos/Ação 1.tiff", { format: "tiff", tiffCompression: "lzw" });
    cleanup();
    open();
    choose("exr");
    fireEvent.change(screen.getByLabelText("Profundidade"), { target: { value: "half" } });
    await ok();
    sent("/fotos/Ação 1.exr", { format: "exr", exrHalf: true });
  });

  it("ppp: sugere o do documento, vazio o mantém e some onde o formato não guarda", async () => {
    ipc.documentDpi.mockResolvedValueOnce(300);
    open();
    const dpi = () => screen.getByTestId("export-dpi") as HTMLInputElement;
    await vi.waitFor(() => expect(dpi().placeholder).toBe("300"));
    await ok();
    cleanup();
    open();
    expect((ipc.exportDoc.mock.calls[0][2] as { dpi?: number }).dpi ?? null).toBeNull();
    fireEvent.change(dpi(), { target: { value: "144" } });
    await ok();
    sent("/fotos/Ação 1.jpg", { dpi: 144 });
    cleanup();
    open();
    fireEvent.change(dpi(), { target: { value: "144" } });
    fireEvent.keyDown(document.body, { key: "Alt" });
    choose("gif");
    expect(screen.queryByTestId("export-dpi")).toBeNull();
    await ok();
    sent("/fotos/Ação 1.gif", { dpi: null });
  });

  it("etiquetas vão com a exportação; se o disco não as guarda, avisa e o arquivo sai", async () => {
    resetToastsForTests();
    ipc.exportTagged.mockResolvedValue({ info: doc, tagsError: { code: "unsupported", message: "" } });
    open();
    const tags = screen.getByPlaceholderText("Adicionar etiqueta");
    fireEvent.change(tags, { target: { value: "Férias" } });
    fireEvent.blur(tags);
    await ok();
    expect(ipc.exportDoc).not.toHaveBeenCalled();
    expect(ipc.exportTagged).toHaveBeenCalledWith(1, "/fotos/Ação 1.jpg", expect.objectContaining({ format: "jpeg" }), null, ["Férias"]);
    expect(getToasts().some((t) => t.text.includes("não guarda as etiquetas"))).toBe(true);
  });
});

describe("Substituir só o arquivo do aviso", () => {
  const replace = () => screen.queryByRole("button", { name: "Substituir" });
  const ok = () => act(async () => fireEvent.click(screen.getByTestId("export-ok")));
  const set = (id: string, value: string) => fireEvent.change(screen.getByTestId(id), { target: { value } });

  beforeEach(() => {
    ipc.exportDoc.mockResolvedValue(doc);
    ipc.pathExists.mockResolvedValue(true);
    render(createElement(ExportDialog, { doc, mode: "export", onClose: () => {} }));
  });
  afterEach(() => void ipc.pathExists.mockResolvedValue(false));

  it.each([
    ["nome", () => set("export-name", "outra.jpg")],
    ["pasta", () => set("export-folder", "/outra")],
    ["formato", () => fireEvent.change(screen.getByLabelText("Formato"), { target: { value: "png" } })],
  ])("mudar %s retira o aviso e o botão", async (_, change) => {
    await ok();
    expect(replace()).not.toBeNull();
    change();
    expect(replace()).toBeNull();
    await ok();
    expect(ipc.exportDoc).not.toHaveBeenCalled();
    expect(replace()).not.toBeNull();
  });

  it("mudar outra opção mantém o aviso, e Substituir grava o arquivo avisado", async () => {
    await ok();
    fireEvent.click(screen.getByLabelText("Remover metadados (EXIF, GPS, IPTC)"));
    await act(async () => fireEvent.click(replace()!));
    expect(ipc.exportDoc).toHaveBeenCalledWith(1, "/fotos/Ação 1.jpg", expect.anything(), null);
  });

  it("nome trocado durante a checagem: Substituir pergunta pelo novo antes de gravar", async () => {
    let exists!: (v: boolean) => void;
    ipc.pathExists.mockImplementationOnce(() => new Promise<boolean>((r) => (exists = r)));
    await ok();
    set("export-name", "outra.jpg");
    await act(async () => exists(true));
    const b = replace();
    if (b) await act(async () => fireEvent.click(b));
    expect(ipc.exportDoc).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("outra.jpg");
    await act(async () => fireEvent.click(replace()!));
    expect(ipc.exportDoc).toHaveBeenCalledWith(1, "/fotos/outra.jpg", expect.anything(), null);
  });
});

describe("ExportSelectedDialog", () => {
  it("Esc durante a exportação não fecha o diálogo", async () => {
    let finish!: () => void;
    ipc.pathExists.mockResolvedValue(false);
    ipc.exportDoc.mockImplementation(() => new Promise((r) => (finish = () => r(doc))));
    const onClose = vi.fn();
    render(createElement(ExportSelectedDialog, { onClose }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Exportar" })));
    await act(async () => fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" }));
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(onClose).toHaveBeenCalled();
  });
});
