import { describe, expect, it } from "vitest";
import i18n from "../i18n";
import { MENUS } from "./menus";
import { searchMenus } from "./menuSearch";

const t = (k: string) => i18n.t(k, { lng: "pt-BR" });

describe("searchMenus", () => {
  it("acha itens de qualquer menu pelo rótulo, sem acento nem caixa, com o caminho", () => {
    const hits = searchMenus("ampli", MENUS, t);
    expect(hits[0]).toMatchObject({ command: "view.zoomIn", label: "Ampliar", path: ["Visualizar"] });
    const nested = searchMenus("versao salva", MENUS, t);
    expect(nested[0]).toMatchObject({ command: "file.revertLastSaved", path: ["Arquivo", "Reverter Para"] });
  });

  it("quem começa com o termo vem antes; vazio e o próprio Pesquisar não entram", () => {
    const labels = searchMenus("barra", MENUS, t).map((h) => h.label);
    expect(labels.length).toBeGreaterThan(1);
    expect(labels.every((l) => /barra/i.test(l))).toBe(true);
    const first = labels.findIndex((l) => !/^barra/i.test(l));
    expect(labels.slice(first).some((l) => /^barra/i.test(l))).toBe(false);
    expect(searchMenus("  ", MENUS, t)).toEqual([]);
    expect(searchMenus("pesquisar", MENUS, t).some((h) => h.command === "help.search")).toBe(false);
  });

  it("todas as palavras precisam aparecer e o limite vale", () => {
    expect(searchMenus("girar direita", MENUS, t).map((h) => h.command)).toEqual(["tools.rotateRight"]);
    expect(searchMenus("a", MENUS, t, 5)).toHaveLength(5);
  });
});
