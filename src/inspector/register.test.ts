import { beforeEach, describe, expect, it, vi } from "vitest";

const editMetadata = vi.fn();
vi.mock("../ipc/commands", () => ({ editMetadata: (...a: unknown[]) => editMetadata(...a) }));
vi.mock("../viewer/actions", () => ({ activeDoc: () => null, viewable: () => false }));

import { runBeforeSave } from "../file/beforeSave";
import { isEnabled } from "../shortcuts/commands";
import "./register";
import { resetTextEditsForTests, seedTexts, setText } from "./textEdits";

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
