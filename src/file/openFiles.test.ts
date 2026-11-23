// L14: abrir arquivos em abas, na mesma janela (barra lateral) ou em janelas separadas.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocId, DocInfo } from "../ipc/types";

const tabs = vi.hoisted(() => ({
  openHere: vi.fn<(p: string[]) => Promise<unknown[]>>(),
  moveDocs: vi.fn<(ids: number[], deliver: unknown) => Promise<boolean>>(),
}));
vi.mock("../tabs/open", () => ({ openHere: tabs.openHere }));
vi.mock("../tabs/transfer", () => ({ moveDocs: tabs.moveDocs }));

import { newWindow } from "../ipc/commands";
import { resetDocsForTests, useDocs } from "../store/docs";
import { getPrefs, resetPrefsForTests, setPrefs } from "../store/prefs";
import { resetUiForTests, useUi } from "../store/ui";
import { openFiles, separateWindows, showMany } from "./openFiles";

const info = (id: number): DocInfo => ({
  id, path: `/p/${id}.png`, name: `${id}.png`, format: "png", width: 40, height: 30, frames: 1,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 0, error: null,
});
const ids = () => useDocs.getState().docs.map((d) => d.id);
const opens = (...n: number[]) =>
  tabs.openHere.mockImplementation(async () => {
    const docs = n.map(info);
    useDocs.getState().add(docs);
    return docs;
  });

beforeEach(() => {
  resetDocsForTests();
  resetPrefsForTests();
  resetUiForTests();
  tabs.openHere.mockReset();
  tabs.moveDocs.mockReset();
  tabs.moveDocs.mockImplementation(async (moved: DocId[]) => {
    useDocs.getState().detach(moved);
    return true;
  });
});

describe("na mesma janela (padrão) e em abas", () => {
  it.each(["window", "tabs"] as const)("%s: abre aqui e ativa o primeiro", async (mode) => {
    setPrefs({ openFilesIn: mode });
    useDocs.getState().add([info(1)]);
    opens(2, 3);
    await openFiles(["/p/2.png", "/p/3.png"]);
    expect(ids()).toEqual([1, 2, 3]);
    expect(useDocs.getState().activeId).toBe(2);
    expect(tabs.moveDocs).not.toHaveBeenCalled();
  });

  it("várias imagens: barra lateral ou barra de abas, conforme a preferência", () => {
    showMany();
    expect([useUi.getState().sidebar, getPrefs().tabBar]).toEqual(["thumbs", false]);
    resetUiForTests();
    setPrefs({ openFilesIn: "tabs" });
    showMany();
    expect([useUi.getState().sidebar, getPrefs().tabBar]).toEqual(["hidden", true]);
    resetUiForTests();
    setPrefs({ openFilesIn: "windows", tabBar: false });
    showMany();
    expect([useUi.getState().sidebar, getPrefs().tabBar]).toEqual(["hidden", false]);
  });
});

describe("em janelas separadas", () => {
  beforeEach(() => setPrefs({ openFilesIn: "windows" }));

  it("janela vazia: o primeiro fica, os outros vão cada um para a sua", async () => {
    opens(1, 2, 3);
    await openFiles(["/p/1.png", "/p/2.png", "/p/3.png"]);
    expect(ids()).toEqual([1]);
    expect(tabs.moveDocs.mock.calls).toEqual([[[2], newWindow], [[3], newWindow]]);
  });

  it("janela com imagem: todos vão para janelas novas e a ativa continua a mesma", async () => {
    useDocs.getState().add([info(1)]);
    opens(2, 3);
    await openFiles(["/p/2.png", "/p/3.png"]);
    expect(ids()).toEqual([1]);
    expect(useDocs.getState().activeId).toBe(1);
  });

  it("se não der para mover, a imagem fica e aparece nesta janela", async () => {
    useDocs.getState().add([info(1)]);
    tabs.moveDocs.mockResolvedValue(false);
    opens(2);
    await openFiles(["/p/2.png"]);
    expect(ids()).toEqual([1, 2]);
    expect(useDocs.getState().activeId).toBe(2);
  });

  it("os arquivos da linha de comando se separam ao iniciar", async () => {
    useDocs.getState().add([info(1), info(2)]);
    await separateWindows(useDocs.getState().docs);
    expect(tabs.moveDocs.mock.calls).toEqual([[[2], newWindow]]);
    expect(ids()).toEqual([1]);
  });

  it("abrir muitos de uma vez: no máximo 8 janelas novas, o resto fica aqui (memória)", async () => {
    opens(...Array.from({ length: 30 }, (_, i) => i + 1));
    await openFiles(Array.from({ length: 30 }, (_, i) => `/p/${i + 1}.png`));
    expect(tabs.moveDocs).toHaveBeenCalledTimes(8);
    expect(ids()).toEqual([1, ...Array.from({ length: 21 }, (_, i) => i + 10)]);
    expect(tabs.moveDocs.mock.calls.map((c) => c[0])).toEqual([[2], [3], [4], [5], [6], [7], [8], [9]]);
  });

  it("nada aberto (já estava em outra janela): nada a fazer", async () => {
    opens();
    await openFiles(["/p/1.png"]);
    expect(tabs.moveDocs).not.toHaveBeenCalled();
  });
});

it("fora do modo de janelas separadas, separateWindows não mexe em nada", async () => {
  useDocs.getState().add([info(1), info(2)]);
  await separateWindows(useDocs.getState().docs);
  expect(tabs.moveDocs).not.toHaveBeenCalled();
});
