import { describe, expect, it } from "vitest";
import type { TextLine } from "../ipc/types";
import { allText, buildModel, detectData, findMatches, rangeText, wordAt } from "./text";

const line = (y: number, ...words: string[]): TextLine => {
  let x = 0;
  const ws = words.map((text) => {
    const w = { text, bbox: { x, y, w: text.length * 10, h: 20 } };
    x += text.length * 10 + 10;
    return w;
  });
  return { text: words.join(" "), bbox: { x: 0, y, w: x - 10, h: 20 }, words: ws };
};

const LINES = [line(0, "Ação", "e", "Coração"), line(40, "João", "não", "está", "só.")];

describe("modelo do texto", () => {
  it("junta palavras com espaço e linhas com quebra", () => {
    const m = buildModel(LINES);
    expect(m.text).toBe("Ação e Coração\nJoão não está só.");
    expect(m.words.map((w) => [w.line, m.text.slice(w.start, w.end)])).toEqual([
      [0, "Ação"], [0, "e"], [0, "Coração"], [1, "João"], [1, "não"], [1, "está"], [1, "só."],
    ]);
    expect(allText(LINES)).toBe(m.text);
  });

  it("texto de um intervalo de palavras, em qualquer direção", () => {
    const m = buildModel(LINES);
    expect(rangeText(m, 1, 4)).toBe("e Coração\nJoão não");
    expect(rangeText(m, 4, 1)).toBe("e Coração\nJoão não");
    expect(rangeText(m, 6, 6)).toBe("só.");
  });

  it("palavra sob o ponto, ou a mais próxima na mesma linha", () => {
    const m = buildModel(LINES);
    expect(wordAt(m, 5, 10)).toBe(0);
    expect(wordAt(m, 75, 50)).toBe(4);
    expect(wordAt(m, 500, 45, true)).toBe(6);
    expect(wordAt(m, 500, 45)).toBeNull();
    expect(wordAt(m, 5, 300)).toBeNull();
  });
});

describe("Localizar", () => {
  it("ignora maiúsculas e acentos e marca as palavras do trecho", () => {
    const m = buildModel(LINES);
    const r = findMatches(m, "coracao");
    expect(r).toHaveLength(1);
    expect(r[0].words).toEqual([2]);
    expect(findMatches(m, "AO").map((x) => x.words)).toEqual([[0], [2], [3], [4]]);
    expect(findMatches(m, "e coração joão").map((x) => x.words)).toEqual([[1, 2, 3]]);
    expect(findMatches(m, "  ")).toEqual([]);
    expect(findMatches(m, "xyz")).toEqual([]);
  });
});

describe("detectores de dados", () => {
  it("acha links, e-mails e telefones", () => {
    const lines = [
      line(0, "Visite", "https://exemplo.com.br/a.", "ou", "www.gera.dev"),
      line(40, "Contato:", "ana.silva@exemplo.com.br"),
      line(80, "Tel", "(11)", "98765-4321", "ou", "+55", "11", "3333-4444"),
    ];
    const found = detectData(buildModel(lines)).map((d) => [d.kind, d.text, d.href]);
    expect(found).toEqual([
      ["link", "https://exemplo.com.br/a", "https://exemplo.com.br/a"],
      ["link", "www.gera.dev", "https://www.gera.dev"],
      ["email", "ana.silva@exemplo.com.br", "mailto:ana.silva@exemplo.com.br"],
      ["phone", "(11) 98765-4321", "tel:11987654321"],
      ["phone", "+55 11 3333-4444", "tel:+551133334444"],
    ]);
  });

  it("o e-mail não vira link e as palavras do item são marcadas", () => {
    const m = buildModel([line(0, "a@b.com", "x")]);
    const d = detectData(m);
    expect(d.map((x) => x.kind)).toEqual(["email"]);
    expect(d[0].words).toEqual([0]);
  });
});
