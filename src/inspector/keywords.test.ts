import { beforeEach, describe, expect, it } from "vitest";
import { addKeyword, clearKeywords, getPendingKeywords, removeKeyword, resetKeywordsForTests, seedKeywords } from "./keywords";

beforeEach(resetKeywordsForTests);

describe("palavras-chave pendentes", () => {
  it("sem edição não há pendência (a Task 11 não grava nada)", () => {
    seedKeywords(1, ["mar"]);
    expect(getPendingKeywords(1)).toBeNull();
  });

  it("adiciona sem duplicar e sem vazios, parte da lista do arquivo", () => {
    seedKeywords(1, ["mar"]);
    addKeyword(1, " sol ");
    addKeyword(1, "sol");
    addKeyword(1, "   ");
    expect(getPendingKeywords(1)).toEqual(["mar", "sol"]);
  });

  it("remove e permite esvaziar a lista", () => {
    seedKeywords(1, ["mar", "sol"]);
    removeKeyword(1, "mar");
    expect(getPendingKeywords(1)).toEqual(["sol"]);
    removeKeyword(1, "sol");
    expect(getPendingKeywords(1)).toEqual([]);
  });

  it("seed não sobrescreve edição e documentos são independentes", () => {
    seedKeywords(1, ["a"]);
    addKeyword(1, "b");
    seedKeywords(1, ["a"]);
    expect(getPendingKeywords(1)).toEqual(["a", "b"]);
    expect(getPendingKeywords(2)).toBeNull();
    clearKeywords(1);
    expect(getPendingKeywords(1)).toBeNull();
  });
});
