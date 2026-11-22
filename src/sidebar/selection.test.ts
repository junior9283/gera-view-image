import { beforeEach, describe, expect, it } from "vitest";
import type { DocInfo } from "../ipc/types";
import { resetDocsForTests, useDocs } from "../store/docs";
import { gridIndex } from "./order";
import { batchTargets, effectiveSelection, selectionAfterClick, selectionAfterMove, useThumbSelection, type Pick } from "./selection";

const doc = (id: number, over: Partial<DocInfo> = {}): DocInfo => ({
  id, path: `/p/${id}.png`, name: `${id}.png`, format: "png", width: 10, height: 10, frames: 1,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 0, error: null, ...over,
});
const docs = [1, 2, 3, 4, 5].map((i) => doc(i));
const none = { picked: [], anchor: null };

/** Teclado numa lista de uma coluna, como na barra lateral. */
const selectionAfterKey = (list: DocInfo[], activeId: number | null, cur: Pick, key: string, shift: boolean) => {
  const to = gridIndex(key, list.findIndex((d) => d.id === activeId), list.length, 1, 1);
  return to === null ? null : selectionAfterMove(list, activeId, cur, to, shift);
};

describe("effectiveSelection", () => {
  it("sem escolha, a seleção é o documento ativo", () => {
    expect(effectiveSelection(docs, 3, [])).toEqual([3]);
  });
  it("devolve na ordem da barra e ignora fechados", () => {
    expect(effectiveSelection(docs, 4, [4, 9, 2])).toEqual([2, 4]);
  });
  it("seleção que não contém o ativo está vencida", () => {
    expect(effectiveSelection(docs, 5, [1, 2])).toEqual([5]);
  });
});

describe("selectionAfterClick", () => {
  it("clique simples seleciona só o item e o ativa", () => {
    const r = selectionAfterClick(docs, 1, { picked: [1, 2], anchor: 1 }, 3, {});
    expect(r.next).toEqual({ picked: [3], anchor: 3 });
    expect(r.activate).toBe(3);
  });
  it("Ctrl alterna e ativa o que entrou", () => {
    const a = selectionAfterClick(docs, 1, none, 3, { ctrl: true });
    expect([...a.next.picked].sort()).toEqual([1, 3]);
    expect(a.activate).toBe(3);
  });
  it("Ctrl no ativo o tira e ativa outro item que sobrou", () => {
    const r = selectionAfterClick(docs, 3, { picked: [1, 3], anchor: 3 }, 3, { ctrl: true });
    expect(r.next.picked).toEqual([1]);
    expect(r.activate).toBe(1);
  });
  it("Shift estende a partir da âncora, em qualquer direção", () => {
    const r = selectionAfterClick(docs, 2, { picked: [2], anchor: 2 }, 4, { shift: true });
    expect(r.next.picked).toEqual([2, 3, 4]);
    expect(r.next.anchor).toBe(2);
    const back = selectionAfterClick(docs, 4, { picked: [4], anchor: 4 }, 2, { shift: true });
    expect(back.next.picked).toEqual([2, 3, 4]);
  });
  it("Shift sem âncora parte do ativo", () => {
    expect(selectionAfterClick(docs, 2, none, 3, { shift: true }).next.picked).toEqual([2, 3]);
  });
});

describe("selectionAfterKey", () => {
  it("seta move a seleção e o ativo", () => {
    const r = selectionAfterKey(docs, 2, none, "ArrowDown", false)!;
    expect(r.next).toEqual({ picked: [3], anchor: 3 });
    expect(r.activate).toBe(3);
  });
  it("seta no limite fica onde está", () => {
    expect(selectionAfterKey(docs, 5, none, "ArrowDown", false)!.activate).toBe(5);
    expect(selectionAfterKey(docs, 1, none, "ArrowUp", false)!.activate).toBe(1);
  });
  it("Shift+seta estende a partir da âncora", () => {
    const first = selectionAfterKey(docs, 2, { picked: [2], anchor: 2 }, "ArrowDown", true)!;
    expect(first.next.picked).toEqual([2, 3]);
    const second = selectionAfterKey(docs, 3, first.next, "ArrowDown", true)!;
    expect(second.next.picked).toEqual([2, 3, 4]);
    const back = selectionAfterKey(docs, 4, second.next, "ArrowUp", true)!;
    expect(back.next.picked).toEqual([2, 3]);
  });
  it("Home/End vão às pontas; Shift seleciona o intervalo", () => {
    expect(selectionAfterKey(docs, 3, none, "End", false)!.activate).toBe(5);
    expect(selectionAfterKey(docs, 3, { picked: [3], anchor: 3 }, "Home", true)!.next.picked).toEqual([1, 2, 3]);
  });
  it("sem documentos não faz nada", () => {
    expect(selectionAfterKey([], null, none, "ArrowDown", false)).toBeNull();
  });
});

describe("batchTargets", () => {
  beforeEach(() => {
    resetDocsForTests();
    useThumbSelection.setState(none);
  });
  it("usa a seleção da barra, sem documentos com erro", () => {
    const bad = doc(2, { error: "corrupt" as DocInfo["error"] });
    useDocs.setState({ docs: [doc(1), bad, doc(3)], activeId: 1 });
    useThumbSelection.setState({ picked: [1, 2, 3], anchor: 1 });
    expect(batchTargets()).toEqual([1, 3]);
  });
  it("sem seleção, só o ativo", () => {
    useDocs.setState({ docs, activeId: 4 });
    expect(batchTargets()).toEqual([4]);
  });
  it("sem documentos, vazio", () => {
    expect(batchTargets()).toEqual([]);
  });
});
