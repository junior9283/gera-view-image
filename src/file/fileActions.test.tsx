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
}));
vi.mock("../ipc/commands", () => ipc);
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

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
