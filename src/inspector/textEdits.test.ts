import { beforeEach, describe, expect, it } from "vitest";
import { hasUnsaved } from "../file/dirty";
import type { DocInfo } from "../ipc/types";
import { clearKeywords } from "./keywords";
import {
  clearTextEdits, currentText, getPendingTextEdits, resetTextEditsForTests, seedTexts, setText,
} from "./textEdits";

const file = { title: "Praia", description: null, author: "Ana", altText: null };
const doc = (id: number) => ({ id, dirty: false }) as DocInfo;

beforeEach(resetTextEditsForTests);

describe("textos editados no Inspetor", () => {
  it("sem edição não há pendência e o texto vem do arquivo", () => {
    seedTexts(1, file);
    expect(getPendingTextEdits(1)).toBeNull();
    expect(currentText(1, "title")).toBe("Praia");
    expect(currentText(1, "description")).toBe("");
    expect(hasUnsaved(doc(1))).toBe(false);
  });

  it("editar deixa o documento sujo; voltar ao valor do arquivo desfaz", () => {
    seedTexts(1, file);
    setText(1, "title", "Mar");
    expect(getPendingTextEdits(1)).toEqual({ title: "Mar" });
    expect(hasUnsaved(doc(1))).toBe(true);
    setText(1, "title", "Praia");
    expect(getPendingTextEdits(1)).toBeNull();
    expect(hasUnsaved(doc(1))).toBe(false);
  });

  it("apagar um campo do arquivo vira edição vazia (o Rust remove a propriedade)", () => {
    seedTexts(1, file);
    setText(1, "author", "");
    expect(getPendingTextEdits(1)).toEqual({ author: "" });
  });

  it("não vaza entre documentos e não sobrescreve edição ao semear de novo", () => {
    seedTexts(1, file);
    setText(1, "altText", "Um gato");
    seedTexts(1, { ...file, altText: "outro" });
    expect(currentText(1, "altText")).toBe("Um gato");
    expect(getPendingTextEdits(2)).toBeNull();
  });

  it("clearKeywords (depois de salvar ou reverter) descarta as edições de texto", () => {
    seedTexts(1, file);
    setText(1, "title", "Mar");
    clearKeywords(1);
    expect(getPendingTextEdits(1)).toBeNull();
    expect(hasUnsaved(doc(1))).toBe(false);
    clearTextEdits(1);
  });
});
