import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo } from "../ipc/types";
import { confirmAndSave, confirmClose, resetUnsavedForTests, setSaveHandler } from "./unsaved";
import { UnsavedDialog } from "./UnsavedDialog";
import { registerBeforeSave, runBeforeSave } from "./beforeSave";
import { askDiscard, resetFinderUiForTests } from "../finder/store";
import { FinderHost } from "../finder/FinderHost";
import { putVeil, resetTabsForTests } from "../tabs/store";
import { TabsOverlays } from "../tabs/AllTabs";
import { saveAll } from "./unsaved";
import fileCss from "./file.css?raw";
import tabsCss from "../tabs/tabs.css?raw";

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

/** `z-index` da regra cujo seletor é exatamente `selector` (nos CSS do app). */
function zOf(selector: string): number {
  for (const css of [fileCss, tabsCss]) {
    for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const sels = m[1].split(",").map((x) => x.trim());
      const z = /z-index:\s*(\d+)/.exec(m[2]);
      if (z && sels.includes(selector)) return Number(z[1]);
    }
  }
  return 0;
}
/** `z-index` efetivo da camada do diálogo de confirmação. */
const confirmZ = (el: HTMLElement) => {
  const backdrop = el.closest(".file-backdrop") as HTMLElement;
  const raised = [...backdrop.classList].filter((c) => c !== "file-backdrop").map((c) => zOf(`.file-backdrop.${c}`));
  return Math.max(zOf(".file-backdrop"), ...raised);
};

describe("pergunta feita durante o véu (Salvar ao fechar)", () => {
  beforeEach(() => {
    resetTabsForTests();
    resetFinderUiForTests();
  });

  it("o aviso de perdas do Salvar fica acima do véu e atende ao mouse e ao teclado", async () => {
    render(
      <>
        <FinderHost />
        <TabsOverlays />
      </>,
    );
    // Como o `saveDoc` de um AVIF com XMP: lê os metadados e pergunta as perdas antes de gravar.
    let read = () => {};
    setSaveHandler(async (d) => {
      await new Promise<void>((r) => (read = r));
      return askDiscard(d.id, d.name, "file.loss.title", "file.loss.ok", ["XMP"]);
    });
    let ok: boolean | undefined;
    act(() => void saveAll([info(8, { dirty: true, name: "ação.avif" })]).then((r) => (ok = r)));
    expect(document.querySelector(".tabs-veil")).toBeTruthy();
    await act(async () => read());
    const dlg = await screen.findByRole("alertdialog", { description: "XMP" });
    expect(confirmZ(dlg)).toBeGreaterThan(zOf(".tabs-veil"));
    expect(dlg.contains(document.activeElement)).toBe(true);
    await act(async () => fireEvent.keyDown(document.activeElement!, { key: "Escape" }));
    expect(ok).toBe(false);
    expect(document.querySelector(".tabs-veil")).toBeNull();
  });

  it("uma confirmação aberta antes do véu continua embaixo dele", async () => {
    render(
      <>
        <FinderHost />
        <TabsOverlays />
      </>,
    );
    act(() => void askDiscard(1, "ação.png", "finder.trash.confirmUnsaved", "finder.trash.ok"));
    const dlg = await screen.findByRole("alertdialog");
    let release = () => {};
    act(() => void (release = putVeil("moving")));
    expect(confirmZ(dlg)).toBeLessThan(zOf(".tabs-veil"));
    act(() => release());
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
