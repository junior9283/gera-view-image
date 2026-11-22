import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo, Op } from "../ipc/types";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { getToasts, resetToastsForTests } from "../chrome/notify";
import { resetDocsForTests, useDocs } from "../store/docs";
import { applyToTargets, reportBatch, resizeFor, runBatch, useBatch } from "./batch";

const doc = (id: number, w = 100, h = 50): DocInfo => ({
  id, path: `/p/${id}.png`, name: `${id}.png`, format: "png", width: w, height: h, frames: 1,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 0, error: null,
});

beforeEach(() => {
  invoke.mockReset();
  resetDocsForTests();
  resetToastsForTests();
  useBatch.setState({ running: false, done: 0, total: 0 });
  useDocs.setState({ docs: [doc(1), doc(2), doc(3)], activeId: 1 });
});

describe("runBatch", () => {
  it("segue depois de uma falha e relata por arquivo", async () => {
    const seen: number[] = [];
    const r = await runBatch([1, 2, 3], async (id) => {
      seen.push(id);
      if (id === 2) throw new Error("disco cheio");
    });
    expect(seen).toEqual([1, 2, 3]);
    expect(r.done).toBe(2);
    expect(r.failed).toEqual([{ id: 2, name: "2.png", error: "disco cheio" }]);
  });

  it("publica o progresso e libera ao fim", async () => {
    const steps: number[] = [];
    const un = useBatch.subscribe((s) => steps.push(s.done));
    await runBatch([1, 2], async () => {});
    un();
    expect(steps).toContain(1);
    expect(useBatch.getState().running).toBe(false);
  });

  it("recusa começar outro lote enquanto um roda", async () => {
    let release = () => {};
    const first = runBatch([1], () => new Promise<void>((r) => (release = r)));
    const second = await runBatch([2], async () => {});
    expect(second.total).toBe(0);
    expect(getToasts().length).toBe(1);
    release();
    await first;
  });

  it("não prende a interface: cede a vez entre as imagens", async () => {
    const order: string[] = [];
    setTimeout(() => order.push("timer"), 0);
    await runBatch([1, 2], async (id) => void order.push(`w${id}`));
    // O timer de 0 ms entra entre o trabalho da primeira e o da segunda imagem.
    expect(order).toEqual(["w1", "timer", "w2"]);
  });
});

describe("applyToTargets", () => {
  it("aplica a op em cada imagem, com o desfazer próprio de cada uma", async () => {
    invoke.mockImplementation(async (cmd: string, a: { id: number }) => ({ ...doc(a.id), rev: 1, canUndo: cmd === "apply_op" }));
    const op: Op = { type: "rotate", data: { quarterTurns: 1 } };
    const r = await applyToTargets([1, 3], () => op);
    expect(r.done).toBe(2);
    expect(invoke.mock.calls.map((c) => [c[0], c[1].id])).toEqual([["apply_op", 1], ["apply_op", 3]]);
    expect(useDocs.getState().docs.map((d) => d.canUndo)).toEqual([true, false, true]);
  });
});

describe("reportBatch", () => {
  it("falhas viram um só aviso com os nomes", () => {
    reportBatch({ total: 3, done: 1, failed: [{ id: 2, name: "b.png", error: "x" }, { id: 3, name: "c.png", error: "y" }] });
    const toasts = getToasts();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].text).toContain("b.png");
    expect(toasts[0].text).toContain("c.png");
  });
  it("uma só imagem sem falha não avisa", () => {
    reportBatch({ total: 1, done: 1, failed: [] });
    expect(getToasts()).toHaveLength(0);
  });
});

describe("resizeFor", () => {
  const orig = { w: 100, h: 50 };
  it("sem proporção, usa o tamanho exato", () => {
    expect(resizeFor(doc(2, 400, 400), { w: 200, h: 80 }, orig, "exact")).toEqual({ w: 200, h: 80 });
  });
  it("proporcional, cabe na caixa sem distorcer", () => {
    expect(resizeFor(doc(2, 400, 400), { w: 200, h: 100 }, orig, "fit")).toEqual({ w: 100, h: 100 });
    expect(resizeFor(doc(2, 400, 100), { w: 200, h: 100 }, orig, "fit")).toEqual({ w: 200, h: 50 });
  });
  it("percentual, aplica a mesma razão do documento ativo", () => {
    expect(resizeFor(doc(2, 400, 200), { w: 50, h: 25 }, orig, "ratio")).toEqual({ w: 200, h: 100 });
  });
});
