import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo } from "../ipc/types";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
const win = { setFullscreen: vi.fn(async () => {}), minimize: vi.fn(async () => {}), toggleMaximize: vi.fn(async () => {}) };
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));

import { getToasts, resetToastsForTests } from "../chrome/notify";
import { resetDocsForTests, useDocs } from "../store/docs";
import { useSelection } from "../store/selection";
import { resetUiForTests, useUi } from "../store/ui";
import { registerAppCommands } from "./appCommands";
import { isEnabled, isRegistered, resetCommandsForTests, runCommand } from "./commands";

const info = (id: number, extra: Partial<DocInfo> = {}): DocInfo => ({
  id, path: `/p/${id}.png`, name: `${id}.png`, format: "png", width: 400, height: 300, frames: 1,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 0, error: null, ...extra,
});
const flush = () => new Promise((r) => setTimeout(r, 0));

let off: () => void;
beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => (["apply_op", "undo", "redo"].includes(cmd) ? info(1, { rev: 1 }) : undefined));
  resetCommandsForTests();
  resetDocsForTests();
  resetUiForTests();
  resetToastsForTests();
  useSelection.setState({ selection: null, selectionTool: null });
  off = registerAppCommands();
});
afterEach(() => off());

describe("comandos do app", () => {
  it("itens de tarefas futuras ficam sem registro (desabilitados)", () => {
    for (const id of ["file.save", "file.export", "file.print", "file.newFromClipboard", "edit.paste", "tools.annotate.arrow"] as const) {
      expect(isRegistered(id)).toBe(false);
      expect(isEnabled(id)).toBe(false);
    }
  });

  it("desfazer/refazer seguem o histórico e só habilitam quando há o que desfazer", async () => {
    useDocs.getState().add([info(1)]);
    expect(isEnabled("edit.undo")).toBe(false);
    useDocs.getState().update(info(1, { canUndo: true, rev: 1 }));
    expect(isEnabled("edit.undo")).toBe(true);
    runCommand("edit.undo");
    await flush();
    expect(invoke).toHaveBeenCalledWith("undo", { id: 1 });
  });

  it("girar e espelhar aplicam a Op no documento ativo", async () => {
    useDocs.getState().add([info(1)]);
    runCommand("tools.rotateRight");
    runCommand("tools.rotateLeft");
    runCommand("tools.flipH");
    await flush();
    const ops = invoke.mock.calls.filter(([c]) => c === "apply_op").map(([, a]) => (a as { op: unknown }).op);
    expect(ops).toEqual([
      { type: "rotate", data: { quarterTurns: 1 } },
      { type: "rotate", data: { quarterTurns: -1 } },
      { type: "flipH" },
    ]);
  });

  it("copiar exige seleção e a falha vira aviso traduzido", async () => {
    useDocs.getState().add([info(1)]);
    expect(isEnabled("edit.copy")).toBe(false);
    useSelection.getState().setSelection({ type: "rect", data: { x: 0, y: 0, w: 10, h: 10 } });
    expect(isEnabled("edit.copy")).toBe(true);
    vi.spyOn(console, "error").mockImplementation(() => {});
    invoke.mockRejectedValueOnce({ code: "empty_selection", message: "vazia" });
    runCommand("edit.copy");
    await flush();
    expect(getToasts().map((t) => t.text)).toEqual(["Faça uma seleção primeiro"]);
  });

  it("Esc: sai da apresentação; senão desmarca", async () => {
    useDocs.getState().add([info(1)]);
    useSelection.getState().setSelection({ type: "rect", data: { x: 0, y: 0, w: 10, h: 10 } });
    useUi.setState({ slideshow: true });
    runCommand("edit.deselect");
    await flush();
    expect(useUi.getState().slideshow).toBe(false);
    expect(useSelection.getState().selection).not.toBeNull();
    runCommand("edit.deselect");
    expect(useSelection.getState().selection).toBeNull();
  });

  it("barra de Marcação dispara gvi:toggle-markup", () => {
    const on = vi.fn();
    window.addEventListener("gvi:toggle-markup", on);
    runCommand("view.markupBar");
    window.removeEventListener("gvi:toggle-markup", on);
    expect(on).toHaveBeenCalledTimes(1);
  });

  it("Ampliar Seleção enquadra o retângulo da seleção", () => {
    useDocs.getState().add([info(1)]);
    useUi.getState().setViewSize({ w: 200, h: 100 });
    useSelection.getState().setSelection({ type: "rect", data: { x: 100, y: 100, w: 100, h: 50 } });
    runCommand("view.zoomToSelection");
    expect(useUi.getState().view).toMatchObject({ scale: 2, panX: -200, panY: -200, mode: "free" });
  });

  it("barra lateral: Ctrl+Alt+1/2/3", () => {
    runCommand("view.thumbnails");
    expect(useUi.getState().sidebar).toBe("thumbs");
    runCommand("view.contactSheet");
    expect(useUi.getState().sidebar).toBe("contact");
    runCommand("view.hideSidebar");
    expect(useUi.getState().sidebar).toBe("hidden");
  });
});
