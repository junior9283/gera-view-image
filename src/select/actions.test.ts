import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo, Mask } from "../ipc/types";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { useDocs } from "../store/docs";
import { useSelection } from "../store/selection";
import {
  canPaste,
  copySelection,
  cropToSelection,
  cutSelection,
  deleteSelection,
  deselect,
  invertSelection,
  selectAll,
  startInstantAlpha,
} from "./actions";
import { maskArea } from "./lasso";

const info = (extra: Partial<DocInfo> = {}): DocInfo => ({
  id: 1, path: "/x/a.png", name: "a.png", format: "png", width: 10, height: 8, frames: 1,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 0, error: null, ...extra,
});
const rect: Mask = { type: "rect", data: { x: 2, y: 1, w: 4, h: 3 } };
const ellipse: Mask = { type: "ellipse", data: { x: 2, y: 1, w: 4, h: 4 } };

const ops = () => invoke.mock.calls.filter((c) => c[0] === "apply_op").map((c) => (c[1] as { op: unknown }).op);

describe("ações de seleção", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: string) => (cmd === "apply_op" ? info({ rev: 1, dirty: true }) : undefined));
    useDocs.setState({ docs: [info()], activeId: 1 });
    useSelection.setState({ selection: null, selectionTool: null });
  });

  it("selectAll seleciona a imagem inteira e deselect limpa", () => {
    selectAll();
    expect(useSelection.getState().selection).toEqual({ type: "rect", data: { x: 0, y: 0, w: 10, h: 8 } });
    deselect();
    expect(useSelection.getState().selection).toBeNull();
  });

  it("invertSelection devolve o complemento (ou nada sem seleção)", () => {
    invertSelection();
    expect(useSelection.getState().selection).toBeNull();
    useSelection.setState({ selection: rect });
    invertSelection();
    const inv = useSelection.getState().selection!;
    expect(inv.type).toBe("bitmap");
    expect(maskArea(inv, 10, 8)).toBe(80 - 12);
  });

  it("cropToSelection com retângulo só corta", async () => {
    useSelection.setState({ selection: rect });
    await cropToSelection();
    expect(ops()).toEqual([{ type: "crop", data: { x: 2, y: 1, w: 4, h: 3 } }]);
    expect(useSelection.getState().selection).toBeNull();
  });

  it("cropToSelection com seleção não retangular apaga fora da máscara antes de cortar", async () => {
    useSelection.setState({ selection: ellipse });
    await cropToSelection();
    const [primeira, segunda] = ops() as { type: string; data: Mask }[];
    expect(primeira.type).toBe("makeTransparent");
    expect(primeira.data.type).toBe("bitmap");
    expect(segunda).toEqual({ type: "crop", data: { x: 2, y: 1, w: 4, h: 4 } });
  });

  it("copySelection manda a máscara ao Rust", async () => {
    useSelection.setState({ selection: rect });
    await copySelection();
    expect(invoke).toHaveBeenCalledWith("copy_region", { id: 1, mask: rect });
  });

  it("cutSelection copia e depois apaga; sem seleção não faz nada", async () => {
    await cutSelection();
    expect(invoke).not.toHaveBeenCalled();
    useSelection.setState({ selection: rect });
    await cutSelection();
    expect(invoke.mock.calls.map((c) => c[0])).toEqual(["copy_region", "apply_op"]);
    expect(ops()).toEqual([{ type: "erase", data: rect }]);
  });

  it("deleteSelection apaga a seleção", async () => {
    useSelection.setState({ selection: ellipse });
    await deleteSelection();
    expect(ops()).toEqual([{ type: "erase", data: ellipse }]);
  });

  it("startInstantAlpha ativa a ferramenta; colar está desabilitado", () => {
    startInstantAlpha();
    expect(useSelection.getState().selectionTool).toBe("instantAlpha");
    expect(canPaste()).toBe(false);
  });

  it("sem documento ativo nada acontece", async () => {
    useDocs.setState({ docs: [], activeId: null });
    useSelection.setState({ selection: rect });
    await cropToSelection();
    selectAll();
    expect(invoke).not.toHaveBeenCalled();
  });
});
