import { beforeEach, describe, expect, it } from "vitest";
import { useDocs, resetDocsForTests } from "../store/docs";
import type { DocInfo } from "../ipc/types";
import { markupCommands } from "./commands";
import { resetMarkupForTests, useMarkup } from "./store";

const info: DocInfo = {
  id: 3, path: "/a.png", name: "a.png", format: "png", width: 10, height: 10, frames: 1,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 1, error: null,
};

const byId = () => Object.fromEntries(markupCommands().map((c) => [c.id, c]));

beforeEach(() => {
  resetDocsForTests();
  resetMarkupForTests();
});

describe("comandos de menu da Marcação", () => {
  it("expõe Ferramentas › Anotar ▸ e Visualizar › Barra de Marcação", () => {
    expect(markupCommands().map((c) => c.id)).toEqual([
      "tools.annotate.rect", "tools.annotate.oval", "tools.annotate.line", "tools.annotate.arrow",
      "tools.annotate.text", "tools.annotate.bubble", "tools.annotate.star", "tools.annotate.polygon",
      "tools.annotate.loupe", "tools.annotate.highlight", "tools.annotate.signature", "view.markupBar",
    ]);
  });

  it("anotar exige documento aberto; a barra sempre alterna", () => {
    const c = byId();
    expect(c["tools.annotate.rect"].enabled()).toBe(false);
    expect(c["view.markupBar"].enabled()).toBe(true);
    useDocs.getState().add([info]);
    expect(c["tools.annotate.rect"].enabled()).toBe(true);
    useDocs.getState().update({ ...info, rev: 2, error: "corrupt" });
    expect(c["tools.annotate.rect"].enabled()).toBe(false);
  });

  it("anotar mostra a barra e escolhe a ferramenta; assinatura abre o painel", () => {
    useDocs.getState().add([info]);
    const c = byId();
    c["tools.annotate.loupe"].run();
    expect(useMarkup.getState()).toMatchObject({ visible: true, tool: "loupe" });
    c["tools.annotate.text"].run();
    expect(useMarkup.getState().tool).toBe("text");
    c["tools.annotate.signature"].run();
    expect(useMarkup.getState().menu).toBe("signature");
    c["view.markupBar"].run();
    expect(useMarkup.getState().visible).toBe(false);
  });
});
