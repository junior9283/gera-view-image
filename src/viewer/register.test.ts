import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo } from "../ipc/types";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({}) }));

import { isEnabled, runCommand } from "../shortcuts/commands";
import { resetDocsForTests, useDocs } from "../store/docs";
import { getPrefs, resetPrefsForTests } from "../store/prefs";
import { resetUiForTests } from "../store/ui";
import { answerUnsaved, currentUnsaved, resetUnsavedForTests } from "../file/unsaved";
import { magnifierOn, resetMagnifierForTests } from "./Magnifier";
import { activate } from "./actions";
import { resetHistoryForTests } from "./history";
import "./register";

const info = (id: number, extra: Partial<DocInfo> = {}): DocInfo => ({
  id, path: `/pasta/${id}.png`, name: `${id}.png`, format: "png", width: 40, height: 30, frames: 1,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 0, error: null, ...extra,
});
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const ids = () => useDocs.getState().docs.map((d) => d.id);

beforeEach(() => {
  invoke.mockReset();
  resetDocsForTests();
  resetPrefsForTests();
  resetUiForTests();
  resetUnsavedForTests();
  resetMagnifierForTests();
  resetHistoryForTests();
});

describe("Lote 8: comandos registrados", () => {
  it("Fechar Todas fecha todos, desabilitado sem documentos", async () => {
    expect(isEnabled("file.closeAll")).toBe(false);
    useDocs.getState().add([info(1), info(2)]);
    expect(runCommand("file.closeAll")).toBe(true);
    await vi.waitFor(() => expect(ids()).toEqual([]));
  });

  it("Fechar Todas passa pelo diálogo de não salvo e Cancelar mantém tudo", async () => {
    useDocs.getState().add([info(1, { dirty: true }), info(2)]);
    runCommand("file.closeAll");
    await vi.waitFor(() => expect(currentUnsaved()).not.toBeNull());
    answerUnsaved("cancel");
    await flush();
    expect(ids()).toEqual([1, 2]);
  });

  it("Mostrar Fundo da Imagem alterna a preferência", () => {
    expect(getPrefs().showImageBackground).toBe(true);
    runCommand("view.imageBackground");
    expect(getPrefs().showImageBackground).toBe(false);
    runCommand("view.imageBackground");
    expect(getPrefs().showImageBackground).toBe(true);
  });

  it("Mostrar Lupa só com imagem e alterna", () => {
    expect(isEnabled("tools.magnifier")).toBe(false);
    useDocs.getState().add([info(1)]);
    runCommand("tools.magnifier");
    expect(magnifierOn()).toBe(true);
    runCommand("tools.magnifier");
    expect(magnifierOn()).toBe(false);
  });

  it("` no ABNT2 (tecla morta com Shift) liga a lupa", () => {
    useDocs.getState().add([info(1)]);
    const e = new KeyboardEvent("keydown", { key: "Dead", code: "BracketLeft", shiftKey: true, cancelable: true });
    window.dispatchEvent(e);
    expect(magnifierOn()).toBe(true);
    expect(e.defaultPrevented).toBe(true);
    // ´ sem Shift (acento agudo) não é a crase.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Dead", code: "BracketLeft" }));
    expect(magnifierOn()).toBe(true);
  });

  it("Voltar/Avançar seguem o histórico", async () => {
    useDocs.getState().add([info(1), info(2)]);
    await flush();
    expect(isEnabled("go.back")).toBe(false);
    activate(2);
    await flush();
    expect(isEnabled("go.back")).toBe(true);
    runCommand("go.back");
    await vi.waitFor(() => expect(useDocs.getState().activeId).toBe(1));
    expect(isEnabled("go.forward")).toBe(true);
  });
});
