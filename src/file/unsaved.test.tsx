import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo } from "../ipc/types";
import { confirmAndSave, confirmClose, resetUnsavedForTests, setSaveHandler } from "./unsaved";
import { UnsavedDialog } from "./UnsavedDialog";
import { registerBeforeSave, runBeforeSave } from "./beforeSave";

const info = (id: number, extra: Partial<DocInfo> = {}): DocInfo => ({
  id, path: `/pasta/${id}.png`, name: `foto ${id}.png`, format: "png", width: 10, height: 10, frames: 1,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 0, error: null, ...extra,
});

beforeEach(() => {
  resetUnsavedForTests();
  render(<UnsavedDialog />);
});
afterEach(cleanup);

describe("confirmClose", () => {
  it("sem documentos (ou nenhum sujo) resolve 'discard' sem diálogo", async () => {
    expect(await confirmClose([])).toBe("discard");
    expect(await confirmClose([info(1)])).toBe("discard");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("com um doc sujo mostra o diálogo com o nome do arquivo", async () => {
    let choice: string | undefined;
    act(() => void confirmClose([info(1), info(2, { dirty: true })]).then((c) => (choice = c)));
    const dlg = await screen.findByRole("alertdialog");
    expect(dlg.textContent).toContain("foto 2.png");
    expect(dlg.textContent).not.toContain("foto 1.png");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cancelar" })));
    expect(choice).toBe("cancel");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("os três botões devolvem a escolha", async () => {
    for (const [label, want] of [["Salvar", "save"], ["Não Salvar", "discard"]] as const) {
      let choice: string | undefined;
      act(() => void confirmClose([info(3, { dirty: true })]).then((c) => (choice = c)));
      await act(async () => fireEvent.click(await screen.findByRole("button", { name: label })));
      expect(choice).toBe(want);
    }
  });

  it("Esc cancela", async () => {
    let choice: string | undefined;
    act(() => void confirmClose([info(4, { dirty: true })]).then((c) => (choice = c)));
    const dlg = await screen.findByRole("alertdialog");
    await act(async () => fireEvent.keyDown(dlg, { key: "Escape" }));
    expect(choice).toBe("cancel");
  });
});

describe("confirmAndSave", () => {
  it("'save' salva os sujos e só libera se todos salvarem", async () => {
    const saved: number[] = [];
    setSaveHandler(async (d) => {
      saved.push(d.id);
      return d.id !== 6;
    });
    let ok: boolean | undefined;
    act(() => void confirmAndSave([info(5, { dirty: true }), info(7)]).then((r) => (ok = r)));
    await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Salvar" })));
    expect(saved).toEqual([5]);
    expect(ok).toBe(true);

    act(() => void confirmAndSave([info(6, { dirty: true })]).then((r) => (ok = r)));
    await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Salvar" })));
    expect(ok).toBe(false);
  });
});

describe("beforeSave", () => {
  it("roda os ganchos registrados, em ordem, e o remover desliga", async () => {
    const calls: string[] = [];
    const off = registerBeforeSave(async (id) => void calls.push(`a${id}`));
    registerBeforeSave(async (id) => void calls.push(`b${id}`));
    await runBeforeSave(9);
    off();
    await runBeforeSave(1);
    expect(calls).toEqual(["a9", "b9", "b1"]);
  });

  it("erro num gancho interrompe o salvar", async () => {
    registerBeforeSave(async () => {
      throw new Error("falhou");
    });
    await expect(runBeforeSave(1)).rejects.toThrow("falhou");
  });
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
