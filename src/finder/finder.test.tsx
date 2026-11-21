// Lote 5 (Finder no Linux): Salvar Como, Lixo, etiquetas, bloquear, versões e popover do título.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo } from "../ipc/types";

const ipc = vi.hoisted(() => ({
  saveAs: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  moveToTrash: vi.fn(async () => {}),
  closeDocument: vi.fn(async () => {}),
  fileTags: vi.fn(async () => ["Praia"]),
  setFileTags: vi.fn(async (_id: number, tags: string[]) => tags),
  fileLocked: vi.fn(async () => false),
  setLocked: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  listVersions: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => []),
  restoreVersion: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  versionPreview: vi.fn(async () => ({ width: 1, height: 1, data: new Uint8ClampedArray(4) })),
  thumbnail: vi.fn(async () => ({ width: 1, height: 1, data: new Uint8ClampedArray(4) })),
  setVersionsLimit: vi.fn(async () => {}),
}));
vi.mock("../ipc/commands", () => ipc);
const dialog = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn<(...a: unknown[]) => Promise<string | null>>() }));
vi.mock("@tauri-apps/plugin-dialog", () => dialog);

import { getToasts, resetToastsForTests } from "../chrome/notify";
import { registerBeforeSave } from "../file/beforeSave";
import { addKeyword, getPendingKeywords, resetKeywordsForTests } from "../inspector/keywords";
import { Slot } from "../lib/slots";
import { isEnabled } from "../shortcuts/commands";
import { useDocs } from "../store/docs";
import { setPrefs } from "../store/prefs";
import { addTags, moveActiveToTrash, saveAsActive, saveAsFormat, splitTags } from "./actions";
import "./register";
import { openVersions, resetFinderUiForTests, useFinderUi } from "./store";

const doc: DocInfo = {
  id: 1, path: "/fotos/Praia 1.jpg", name: "Praia 1.jpg", format: "jpeg", width: 40, height: 20, frames: 1,
  delaysMs: [], plays: 0, writable: true, dirty: false, canUndo: false, canRedo: false, rev: 1, error: null,
};

const toasts = () => getToasts().map((t) => t.text);

beforeEach(() => {
  vi.clearAllMocks();
  setPrefs({ language: "pt-BR" });
  resetKeywordsForTests();
  resetToastsForTests();
  resetFinderUiForTests();
  useDocs.setState({ docs: [doc], activeId: 1 });
});
afterEach(cleanup);

describe("auxiliares", () => {
  it("Salvar Como aceita só extensões que o Salvar regrava", () => {
    expect(saveAsFormat("/a/b.JPG")).toBe("jpeg");
    expect(saveAsFormat("/a/b.tif")).toBe("tiff");
    expect(saveAsFormat("/a/b.exr")).toBeNull();
    expect(saveAsFormat("/a.d/sem-extensao")).toBeNull();
  });

  it("a vírgula separa etiquetas (é o separador do user.xdg.tags)", () => {
    expect(splitTags(" a, b ,,c ")).toEqual(["a", "b", "c"]);
    expect(addTags(["a"], "b,a")).toEqual(["a", "b"]);
  });
});

describe("comandos", () => {
  it("habilitam com um documento ligado a arquivo", () => {
    for (const id of ["file.saveAs", "file.moveToTrash", "file.tags", "file.lock", "file.browseVersions"] as const) {
      expect(isEnabled(id), id).toBe(true);
    }
    useDocs.setState({ docs: [{ ...doc, path: "" }], activeId: 1 });
    expect(isEnabled("file.moveToTrash")).toBe(false);
    expect(isEnabled("file.saveAs")).toBe(true);
  });

  it("manda o limite das versões ao Rust quando a preferência muda", () => {
    setPrefs({ versionsMaxMb: 64 });
    expect(ipc.setVersionsLimit).toHaveBeenLastCalledWith(64);
  });
});

describe("Salvar Como", () => {
  it("achata antes, grava no destino escolhido e o documento passa a ser ele", async () => {
    const order: string[] = [];
    const off = registerBeforeSave(async () => void order.push("before"));
    dialog.save.mockResolvedValue("/outra/Nova.png");
    ipc.saveAs.mockImplementation(async () => {
      order.push("saveAs");
      return { ...doc, path: "/outra/Nova.png", name: "Nova.png", format: "png", rev: 2 };
    });
    addKeyword(1, "mar");
    await saveAsActive();
    off();
    expect(order).toEqual(["before", "saveAs"]);
    expect(dialog.save.mock.calls[0][0]).toMatchObject({ defaultPath: "/fotos/Praia 1.jpg" });
    expect(ipc.saveAs).toHaveBeenCalledWith(1, "/outra/Nova.png", expect.objectContaining({ format: "png" }), ["mar"]);
    expect(useDocs.getState().docs[0].path).toBe("/outra/Nova.png");
    expect(getPendingKeywords(1)).toBeNull();
  });

  it("extensão que não dá para regravar: avisa e não grava", async () => {
    dialog.save.mockResolvedValue("/outra/x.exr");
    await saveAsActive();
    expect(ipc.saveAs).not.toHaveBeenCalled();
    expect(toasts().some((t) => t.includes(".avif"))).toBe(true);
  });
});

describe("Mover para o Lixo", () => {
  it("documento sem alterações vai direto e é fechado", async () => {
    await moveActiveToTrash();
    expect(ipc.moveToTrash).toHaveBeenCalledWith(1);
    expect(ipc.closeDocument).toHaveBeenCalledWith(1);
    expect(useDocs.getState().docs).toEqual([]);
  });

  it("com alterações pergunta; Cancelar não mexe no arquivo", async () => {
    useDocs.setState({ docs: [{ ...doc, dirty: true }], activeId: 1 });
    render(<Slot name="above-content" props={{}} />);
    const done = moveActiveToTrash();
    fireEvent.click(await screen.findByRole("button", { name: "Cancelar" }));
    await done;
    expect(ipc.moveToTrash).not.toHaveBeenCalled();
    expect(useDocs.getState().docs).toHaveLength(1);

    const again = moveActiveToTrash();
    fireEvent.click(await screen.findByRole("button", { name: "Mover para o Lixo" }));
    await again;
    expect(ipc.moveToTrash).toHaveBeenCalledWith(1);
  });

  it("falha no Lixo: o documento continua aberto", async () => {
    ipc.moveToTrash.mockRejectedValueOnce({ code: "io", message: "sem lixeira" });
    await expect(moveActiveToTrash()).rejects.toBeTruthy();
    expect(ipc.closeDocument).not.toHaveBeenCalled();
    expect(useDocs.getState().docs).toHaveLength(1);
  });
});

describe("popover do título", () => {
  const renderTitle = () => render(<Slot name="title-accessory" props={{ title: doc.name }} />);

  it("sem arquivo não mostra o botão", () => {
    useDocs.setState({ docs: [{ ...doc, path: "" }], activeId: 1 });
    renderTitle();
    expect(screen.queryByRole("button", { name: /etiquetas/ })).toBeNull();
  });

  it("mostra nome, etiquetas, local e Bloqueado; grava etiquetas e bloqueio", async () => {
    ipc.setLocked.mockResolvedValue({ ...doc, writable: false, rev: 2 });
    renderTitle();
    fireEvent.click(screen.getByRole("button", { name: /etiquetas/ }));
    const pop = await screen.findByRole("dialog", { name: "Informações do arquivo" });
    expect((screen.getByRole("textbox", { name: "Nome" }) as HTMLInputElement).value).toBe("Praia 1");
    expect(pop.textContent).toContain("fotos");
    await screen.findByText("Praia");

    const input = screen.getByRole("textbox", { name: "Adicionar etiqueta" });
    fireEvent.change(input, { target: { value: "Férias, Mar" } });
    expect((input as HTMLInputElement).value).toBe("Férias Mar");
    fireEvent.change(input, { target: { value: "Férias" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(ipc.setFileTags).toHaveBeenLastCalledWith(1, ["Praia", "Férias"]);
    fireEvent.click(await screen.findByRole("button", { name: "Remover Praia" }));
    expect(ipc.setFileTags).toHaveBeenLastCalledWith(1, ["Férias"]);

    const lock = screen.getByRole("checkbox", { name: "Bloqueado" });
    await waitFor(() => expect((lock as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(lock);
    await waitFor(() => expect(ipc.setLocked).toHaveBeenCalledWith(1, true));
    await waitFor(() => expect(useDocs.getState().docs[0].writable).toBe(false));
    expect(useFinderUi.getState().locked[1]).toBe(true);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Procurar Todas as Versões", () => {
  it("lista as versões e restaura a escolhida sem gravar", async () => {
    ipc.listVersions.mockResolvedValue([
      { id: "2-1.jpg", savedAt: "2026-11-21T10:00:00.000Z", size: 2048 },
      { id: "1-0.jpg", savedAt: "2026-11-20T10:00:00.000Z", size: 1024 },
    ]);
    ipc.restoreVersion.mockResolvedValue({ ...doc, dirty: true, rev: 3 });
    render(<Slot name="above-content" props={{}} />);
    act(() => openVersions(1));
    const items = await screen.findAllByRole("button", { pressed: false });
    expect(screen.getByRole("button", { pressed: true }).textContent).toContain("2 KB");
    fireEvent.click(items.find((b) => b.textContent?.includes("1 KB"))!);
    fireEvent.click(screen.getByRole("button", { name: "Restaurar" }));
    await waitFor(() => expect(ipc.restoreVersion).toHaveBeenCalledWith(1, "1-0.jpg"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(useDocs.getState().docs[0].dirty).toBe(true);
    expect(ipc.versionPreview).toHaveBeenCalledWith(1, "1-0.jpg", expect.any(Number));
  });

  it("com alterações não salvas, Restaurar pergunta; Cancelar mantém as edições", async () => {
    ipc.listVersions.mockResolvedValue([{ id: "1-0.jpg", savedAt: "2026-11-20T10:00:00.000Z", size: 1024 }]);
    ipc.restoreVersion.mockResolvedValue({ ...doc, dirty: true, rev: 3 });
    const sujo = { ...doc, dirty: true, canUndo: true, rev: 2 };
    useDocs.setState({ docs: [sujo], activeId: 1 });
    render(<Slot name="above-content" props={{}} />);
    act(() => openVersions(1));
    await screen.findByRole("button", { pressed: true });
    fireEvent.click(screen.getByRole("button", { name: "Restaurar" }));
    const pergunta = await screen.findByRole("alertdialog");
    expect(pergunta.textContent).toContain("Restaurar a versão e descartá-las?");
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(ipc.restoreVersion).not.toHaveBeenCalled();
    expect(useDocs.getState().docs[0]).toEqual(sujo);
    // O navegador continua aberto, e confirmar restaura.
    const restaurar = screen.getByRole("button", { name: "Restaurar" }) as HTMLButtonElement;
    await waitFor(() => expect(restaurar.disabled).toBe(false));
    fireEvent.click(restaurar);
    const ok = await screen.findByRole("alertdialog");
    fireEvent.click(within(ok).getByRole("button", { name: "Restaurar" }));
    await waitFor(() => expect(ipc.restoreVersion).toHaveBeenCalledWith(1, "1-0.jpg"));
  });

  it("sem versões explica que cada Salvar guarda uma", async () => {
    ipc.listVersions.mockResolvedValue([]);
    render(<Slot name="above-content" props={{}} />);
    act(() => openVersions(1));
    expect(await screen.findByText(/Cada Salvar guarda/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Restaurar" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
