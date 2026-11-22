import { beforeEach, describe, expect, it, vi } from "vitest";
import { dropDocs, dumpDocs, loadDocs, pack, registerDocState, resetDocStateForTests, settleDocs, unpack } from "./docState";

beforeEach(resetDocStateForTests);

describe("pack/unpack", () => {
  it("vai e volta igual, sem os campos indefinidos", () => {
    const v = { n: 1.5, t: "a", b: true, nulo: null, lista: [1, [2, { x: "y" }], []], vazio: {}, some: undefined };
    expect(unpack(pack(v))).toEqual({ n: 1.5, t: "a", b: true, nulo: null, lista: [1, [2, { x: "y" }], []], vazio: {} });
    for (const p of [null, 3, "x", "y".repeat(500), []]) expect(unpack(pack(p))).toEqual(p);
  });

  it("mantém a identidade entre objetos repetidos", () => {
    const a = { id: "1" };
    const out = unpack(pack({ before: [a], after: [a, { id: "1" }] })) as { before: object[]; after: object[] };
    expect(out.before[0]).toBe(out.after[0]);
    expect(out.after[1]).not.toBe(out.after[0]);
  });

  it("texto longo repetido vai uma vez só", () => {
    const png = "iVBOR".repeat(10_000);
    const steps = Array.from({ length: 50 }, (_, i) => ({ id: i, png: png.slice() }));
    expect(pack(steps).length).toBeLessThan(png.length * 1.1);
    expect((unpack(pack(steps)) as { png: string }[])[49].png).toBe(png);
  });

  it("chaves e textos que parecem referência não confundem", () => {
    const v = { "0": "[1]", table: [[0]], root: { a: [1], o: { x: 1 } } };
    expect(unpack(pack(v))).toEqual(v);
  });
});

describe("partes do estado", () => {
  it("leva o que cada parte tem, entrega e esquece", () => {
    const load = vi.fn();
    const drop = vi.fn();
    registerDocState("a", { dump: (id) => (id === 1 ? { x: id } : undefined), load, drop });
    const states = dumpDocs([1, 2]);
    expect(states).toEqual({ 1: { a: { x: 1 } }, 2: {} });
    loadDocs(unpack(pack(states)) as typeof states);
    expect(load.mock.calls).toEqual([[1, { x: 1 }]]);
    dropDocs([1]);
    expect(drop).toHaveBeenCalledWith(1);
  });

  it("uma parte que falha não impede as outras", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const load = vi.fn();
    registerDocState("quebra", { dump: () => 1, load: () => { throw new Error("x"); } });
    registerDocState("ok", { dump: () => 1, load });
    loadDocs(dumpDocs([7]));
    expect(load).toHaveBeenCalledWith(7, 1);
  });

  it("espera o trabalho em andamento, mesmo que ele falhe", async () => {
    let done = false;
    registerDocState("a", { dump: () => 1, load: () => {}, settle: async () => void (await Promise.resolve(), (done = true)) });
    registerDocState("b", { dump: () => 1, load: () => {}, settle: () => Promise.reject(new Error("x")) });
    await settleDocs([1]);
    expect(done).toBe(true);
  });
});
