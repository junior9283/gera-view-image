import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo } from "../ipc/types";

const ipc = vi.hoisted(() => ({
  save: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  exportDoc: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  estimateSize: vi.fn(async () => 2048),
  pathExists: vi.fn(async () => false),
}));
vi.mock("../ipc/commands", () => ipc);
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

import { useDocs } from "../store/docs";
import { setPrefs } from "../store/prefs";
import { addKeyword, getPendingKeywords, resetKeywordsForTests } from "../inspector/keywords";
import { registerBeforeSave } from "./beforeSave";
import { saveDoc, useFileUi } from "./fileActions";
import { ExportDialog } from "./ExportDialog";

const doc: DocInfo = {
  id: 1, path: "/fotos/Ação 1.jpg", name: "Ação 1.jpg", format: "jpeg", width: 40, height: 20, frames: 1,
  writable: true, dirty: true, canUndo: true, canRedo: false, rev: 1, error: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  // O addRecent do Exportar emite prefs; fixa o idioma para o i18n não voltar ao do sistema (en).
  setPrefs({ language: "pt-BR" });
  resetKeywordsForTests();
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

  it("pergunta antes de substituir um arquivo existente", async () => {
    ipc.pathExists.mockResolvedValue(true);
    ipc.exportDoc.mockResolvedValue(doc);
    render(createElement(ExportDialog, { doc, mode: "export", onClose: () => {} }));
    await act(async () => fireEvent.click(screen.getByTestId("export-ok")));
    expect(ipc.exportDoc).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(await screen.findByText("Substituir")));
    expect(ipc.exportDoc).toHaveBeenCalledWith(1, "/fotos/Ação 1.jpg", expect.anything(), null);
  });

  it("mostra o tamanho estimado (debounce)", async () => {
    render(createElement(ExportDialog, { doc, mode: "export", onClose: () => {} }));
    expect(screen.getByTestId("export-estimate").textContent).toContain("Calculando");
    await vi.waitFor(() => expect(screen.getByTestId("export-estimate").textContent).toContain("2 KB"));
  });
});
