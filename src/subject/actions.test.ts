import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo, Mask } from "../ipc/types";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { getToasts, resetToastsForTests } from "../chrome/notify";
import { useDocs } from "../store/docs";
import { useSelection } from "../store/selection";
import {
  answerDownload, cancelSubject, canSegment, copySubject, invertBitmap, removeBackground, useSubject,
} from "./actions";

const info = (extra: Partial<DocInfo> = {}): DocInfo => ({
  id: 1, path: "/x/a.png", name: "a.png", format: "png", width: 4, height: 2, frames: 1, delaysMs: [], plays: 0,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 0, error: null, ...extra,
});
// 4×2: pixels 1, 2, 5 e 6 são o sujeito.
const subject: Mask = { type: "bitmap", data: { w: 4, h: 2, rle: [1, 2, 2, 2, 1] } };

const calls = (cmd: string) => invoke.mock.calls.filter((c) => c[0] === cmd).map((c) => c[1]);
const flush = () => new Promise((r) => setTimeout(r, 0));

function backend(over: Record<string, (args: unknown) => unknown> = {}) {
  invoke.mockImplementation(async (cmd: string, args: unknown) => {
    if (over[cmd]) return over[cmd](args);
    if (cmd === "segment_model_ready") return true;
    if (cmd === "segment_subject") return subject;
    if (cmd === "apply_op") return info({ rev: 1, dirty: true });
    return undefined;
  });
}

describe("Remover Fundo / Copiar Objeto", () => {
  beforeEach(() => {
    invoke.mockReset();
    backend();
    resetToastsForTests();
    useDocs.setState({ docs: [info()], activeId: 1 });
    useSelection.setState({ selection: null, selectionTool: null });
    useSubject.setState({ phase: { kind: "idle" } });
  });

  it("invertBitmap troca dentro e fora só pelas corridas", () => {
    expect(invertBitmap(subject)).toEqual({ type: "bitmap", data: { w: 4, h: 2, rle: [0, 1, 2, 2, 2, 1] } });
    expect(invertBitmap(invertBitmap(subject))).toEqual(subject);
  });

  it("Remover Fundo aplica makeTransparent no inverso do sujeito (uma op, desfazível)", async () => {
    await removeBackground();
    expect(calls("segment_subject")).toEqual([{ id: 1 }]);
    expect(calls("apply_op")).toEqual([{ id: 1, op: { type: "makeTransparent", data: invertBitmap(subject) } }]);
    expect(useSubject.getState().phase.kind).toBe("idle");
  });

  it("Copiar Objeto seleciona o sujeito e o copia", async () => {
    await copySubject();
    expect(useSelection.getState().selection).toEqual(subject);
    expect(calls("copy_region")).toEqual([{ id: 1, mask: subject }]);
    expect(calls("apply_op")).toEqual([]);
  });

  it("sem o modelo, pergunta antes de baixar; recusar não chama a segmentação", async () => {
    backend({ segment_model_ready: () => false });
    const p = removeBackground();
    await flush();
    expect(useSubject.getState().phase.kind).toBe("ask");
    answerDownload(false);
    await p;
    expect(calls("segment_subject")).toEqual([]);
    expect(useSubject.getState().phase.kind).toBe("idle");
  });

  it("aceitar o download segue com a segmentação e mostra o progresso", async () => {
    let finish!: (m: Mask) => void;
    backend({ segment_model_ready: () => false, segment_subject: () => new Promise<Mask>((r) => (finish = r)) });
    const p = removeBackground();
    await flush();
    answerDownload(true);
    await flush();
    expect(useSubject.getState().phase).toEqual({ kind: "busy", downloading: true });
    finish(subject);
    await p;
    expect(calls("apply_op")).toHaveLength(1);
  });

  it("cancelar descarta o resultado e avisa o backend", async () => {
    let finish!: (m: Mask) => void;
    backend({ segment_subject: () => new Promise<Mask>((r) => (finish = r)) });
    const p = removeBackground();
    await flush();
    expect(canSegment()).toBe(false);
    cancelSubject();
    expect(useSubject.getState().phase.kind).toBe("idle");
    expect(calls("segment_cancel")).toHaveLength(1);
    finish(subject);
    await p;
    expect(calls("apply_op")).toEqual([]);
  });

  it("documento alterado durante o processamento não recebe a máscara velha", async () => {
    let finish!: (m: Mask) => void;
    backend({ segment_subject: () => new Promise<Mask>((r) => (finish = r)) });
    const p = removeBackground();
    await flush();
    useDocs.setState({ docs: [info({ rev: 5, width: 2, height: 4 })] });
    finish(subject);
    await p;
    expect(calls("apply_op")).toEqual([]);
  });

  it("sem sujeito destacado, avisa e não altera nada", async () => {
    backend({ segment_subject: () => Promise.reject({ code: "empty_selection", message: "" }) });
    await removeBackground();
    expect(calls("apply_op")).toEqual([]);
    expect(getToasts().map((t) => t.text)).toEqual(["Nenhum objeto encontrado na imagem"]);
  });

  it("fica desabilitado sem documento ou com documento com erro", () => {
    expect(canSegment()).toBe(true);
    useDocs.setState({ docs: [info({ error: "corrupt" })] });
    expect(canSegment()).toBe(false);
    useDocs.setState({ docs: [], activeId: null });
    expect(canSegment()).toBe(false);
  });
});
