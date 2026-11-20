import { describe, expect, it } from "vitest";
import { ByteLru } from "./byteLru";

const lru = (max: number) => new ByteLru<string, number>(max, (v) => v);

describe("ByteLru", () => {
  it("expulsa as entradas mais antigas quando passa do orçamento em bytes", () => {
    const c = lru(100);
    c.set("a", 40);
    c.set("b", 40);
    c.set("c", 40);
    expect([...c.keys()]).toEqual(["b", "c"]);
    expect(c.bytes).toBe(80);
  });

  it("hit move a entrada para o fim (LRU real)", () => {
    const c = lru(100);
    c.set("a", 40);
    c.set("b", 40);
    expect(c.get("a")).toBe(40);
    c.set("c", 40);
    expect([...c.keys()]).toEqual(["a", "c"]);
  });

  it("mantém a entrada recém-inserida mesmo se sozinha passar do orçamento", () => {
    const c = lru(10);
    c.set("a", 5);
    c.set("big", 50);
    expect([...c.keys()]).toEqual(["big"]);
  });

  it("set da mesma chave substitui e recontabiliza; delete libera bytes", () => {
    const c = lru(100);
    c.set("a", 40);
    c.set("a", 10);
    expect(c.bytes).toBe(10);
    c.delete("a");
    expect(c.bytes).toBe(0);
    expect(c.get("a")).toBeUndefined();
  });
});
