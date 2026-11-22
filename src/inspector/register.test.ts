import { beforeEach, describe, expect, it, vi } from "vitest";

const editMetadata = vi.fn();
vi.mock("../ipc/commands", () => ({ editMetadata: (...a: unknown[]) => editMetadata(...a) }));
vi.mock("../viewer/actions", () => ({ activeDoc: () => null, viewable: () => false }));

import { runBeforeSave } from "../file/beforeSave";
import { hasUncarried } from "../file/dirty";
import { dumpDocs, dropDocs, loadDocs } from "../lib/docState";
import { isEnabled } from "../shortcuts/commands";
import "./register";
import { currentText, hasPendingTextEdits, resetTextEditsForTests, seedTexts, setText } from "./textEdits";

beforeEach(() => {
  editMetadata.mockReset().mockResolvedValue(undefined);
  resetTextEditsForTests();
});

describe("registro do Lote 9", () => {
  it("antes de gravar, entrega ao Rust só o que foi editado e limpa depois que a edição some", async () => {
    await runBeforeSave(1);
    expect(editMetadata).not.toHaveBeenCalled(); // nada editado: nenhuma chamada
    seedTexts(1, { title: "A", description: null, author: null, altText: null });
    setText(1, "title", "B");
    await runBeforeSave(1);
    expect(editMetadata).toHaveBeenLastCalledWith(1, { title: "B" });
    setText(1, "title", "A"); // desfez a edição
    await runBeforeSave(1);
    expect(editMetadata).toHaveBeenLastCalledWith(1, {}); // limpa o que o Rust guardava
    await runBeforeSave(1);
    expect(editMetadata).toHaveBeenCalledTimes(2);
  });

  it("a edição e o aviso de que ela já foi ao Rust acompanham a aba", async () => {
    seedTexts(2, { title: "A", description: null, author: null, altText: null });
    setText(2, "title", "B");
    await runBeforeSave(2);
    const state = dumpDocs([2]);
    dropDocs([2]);
    expect(currentText(2, "title")).toBe("");
    editMetadata.mockClear();
    await runBeforeSave(2);
    expect(editMetadata).not.toHaveBeenCalled(); // a origem esqueceu

    loadDocs(state);
    expect(currentText(2, "title")).toBe("B");
    expect(hasUncarried(2)).toBe(false);
    setText(2, "title", "A"); // de volta ao original, na janela nova
    expect(hasPendingTextEdits(2)).toBe(false);
    await runBeforeSave(2);
    expect(editMetadata).toHaveBeenLastCalledWith(2, {}); // senão o Rust gravaria o título antigo
  });

  it("erro do Rust interrompe a gravação", async () => {
    seedTexts(1, { title: null, description: null, author: null, altText: null });
    setText(1, "author", "Ana");
    editMetadata.mockRejectedValue(new Error("x"));
    await expect(runBeforeSave(1)).rejects.toThrow();
  });

  it("Descrição da Imagem… fica desabilitado sem documento", () => {
    expect(isEnabled("tools.imageDescription")).toBe(false);
  });
});
