import { describe, expect, it } from "vitest";
import type { DocInfo, FileStat } from "../ipc/types";
import { needsStats, sortedIds } from "./sort";

const doc = (id: number, name: string, format = "png" as DocInfo["format"]): DocInfo => ({
  id, path: `/p/${name}`, name, format, width: 10, height: 10, frames: 1,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 0, error: null,
});
const stat = (id: number, modifiedMs: number | null, size: number | null): FileStat => ({ id, modifiedMs, size });

const docs = [doc(1, "img10.png"), doc(2, "Img2.jpg", "jpeg" as DocInfo["format"]), doc(3, "a.png"), doc(4, "z.gif", "gif" as DocInfo["format"])];

describe("sortedIds", () => {
  it("manual mantém a ordem atual", () => {
    expect(sortedIds(docs, "manual", new Map())).toEqual([1, 2, 3, 4]);
  });
  it("nome: ordem natural, sem diferenciar maiúsculas", () => {
    expect(sortedIds(docs, "name", new Map())).toEqual([3, 2, 1, 4]);
  });
  it("tipo: agrupa pelo formato e desempata pelo nome", () => {
    expect(sortedIds(docs, "kind", new Map())).toEqual([4, 2, 3, 1]);
  });
  it("data: mais recente primeiro; sem arquivo vai ao fim", () => {
    const stats = new Map([stat(1, 100, 1), stat(2, 300, 1), stat(3, null, null), stat(4, 200, 1)].map((s) => [s.id, s]));
    expect(sortedIds(docs, "date", stats)).toEqual([2, 4, 1, 3]);
  });
  it("tamanho: maior primeiro; empate pelo nome", () => {
    const stats = new Map([stat(1, 1, 50), stat(2, 1, 900), stat(3, 1, 50), stat(4, 1, 10)].map((s) => [s.id, s]));
    expect(sortedIds(docs, "size", stats)).toEqual([2, 3, 1, 4]);
  });
  it("sem estatística conhecida, cai para o nome", () => {
    expect(sortedIds(docs, "date", new Map())).toEqual([3, 2, 1, 4]);
  });
});

describe("needsStats", () => {
  it("só data e tamanho consultam o disco", () => {
    expect(["manual", "name", "kind"].some((m) => needsStats(m as never))).toBe(false);
    expect(needsStats("date") && needsStats("size")).toBe(true);
  });
});
