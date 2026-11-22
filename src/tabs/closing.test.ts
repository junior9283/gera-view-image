import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo } from "../ipc/types";

const handlers: Record<string, () => unknown> = {};
const calls: [string, unknown][] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: unknown) => {
    calls.push([cmd, args]);
    return handlers[cmd]?.();
  },
}));
const events: Record<string, { cb: (e: { payload: unknown }) => void; target: unknown }> = {};
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: (e: { payload: unknown }) => void, o: { target: unknown }) => {
    events[name] = { cb, target: o.target };
    return () => {};
  },
}));
let onClose!: (e: { preventDefault: () => void }) => void;
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "doc-2",
    onCloseRequested: async (cb: typeof onClose) => ((onClose = cb), () => {}),
    setFocus: async () => {},
  }),
}));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: () => handlers.relaunch?.() ?? Promise.resolve() }));
const toast = vi.hoisted(() => vi.fn());
vi.mock("../chrome/notify", () => ({ notify: toast, notifyError: toast }));

import { answerUnsaved, currentUnsaved, resetUnsavedForTests, setSaveHandler } from "../file/unsaved";
import { runCommand } from "../shortcuts/commands";
import { resetDocsForTests, useDocs } from "../store/docs";
import { resetPrefsForTests } from "../store/prefs";
import { restartApp } from "../updater/updater";
import { quit } from "./closing";
import { openHere } from "./open";
import { resetTabsForTests, useTabs } from "./store";
import { installWindowEvents } from "./windowEvents";
import "../viewer/register";

const info = (id: number, extra: Partial<DocInfo> = {}): DocInfo => ({
  id, path: `/p/${id}.png`, name: `${id}.png`, format: "png", width: 40, height: 30, frames: 1,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 0, error: null, ...extra,
});
const dirty = (id: number) => info(id, { dirty: true });
/** Comandos chamados (o título segue o documento ativo e não interessa aqui). */
const names = () => calls.map(([c]) => c).filter((c) => c !== "set_window_title");
const tick = () => new Promise((r) => setTimeout(r, 0));
const asked = () => vi.waitFor(() => expect(currentUnsaved()).not.toBeNull());
const requestClose = () => {
  const e = { preventDefault: vi.fn() };
  onClose(e);
  expect(e.preventDefault, "quem fecha é o Rust, depois de perguntar").toHaveBeenCalled();
};

await installWindowEvents();

beforeEach(() => {
  for (const k of Object.keys(handlers)) delete handlers[k];
  handlers.seal_window = () => true;
  calls.length = 0;
  toast.mockReset();
  resetDocsForTests();
  resetTabsForTests();
  resetPrefsForTests();
  resetUnsavedForTests();
});

describe("fechar a janela", () => {
  it("sem alterações: sela e fecha, sem diálogo", async () => {
    useDocs.getState().add([info(1)]);
    requestClose();
    await vi.waitFor(() => expect(names()).toContain("close_window"));
    expect(names().indexOf("seal_window")).toBeLessThan(names().indexOf("close_window"));
    expect(currentUnsaved()).toBeNull();
  });

  it("Cancelar mantém a janela, sem selo nem véu", async () => {
    useDocs.getState().add([dirty(1), info(2)]);
    requestClose();
    await asked();
    expect(currentUnsaved()!.docs.map((d) => d.id)).toEqual([1]);
    answerUnsaved("cancel");
    await tick();
    expect(names()).not.toContain("seal_window");
    expect(names()).not.toContain("close_window");
    expect(useTabs.getState().veil).toBeNull();
  });

  it("um que não pôde ser salvo mantém a janela", async () => {
    setSaveHandler(async () => false);
    useDocs.getState().add([dirty(1)]);
    requestClose();
    await asked();
    answerUnsaved("save");
    await tick();
    expect(names()).not.toContain("seal_window");
  });

  it("o que foi editado enquanto os outros eram salvos também é perguntado", async () => {
    useDocs.getState().add([dirty(1), info(2)]);
    setSaveHandler(async (d) => {
      useDocs.getState().update({ ...d, dirty: false, rev: d.rev + 1 });
      useDocs.getState().update(info(2, { dirty: true, rev: 1 }));
      return true;
    });
    requestClose();
    await asked();
    answerUnsaved("save");
    await vi.waitFor(() => expect(currentUnsaved()?.docs.map((d) => d.id)).toEqual([2]));
    expect(names()).not.toContain("seal_window");
    answerUnsaved("discard");
    await vi.waitFor(() => expect(names()).toContain("close_window"));
  });

  it("documento não salvo que chegou durante a pergunta também é perguntado", async () => {
    const seals = [false, true];
    handlers.seal_window = () => seals.shift();
    handlers.take_documents = () => [{ infos: [dirty(5)], state: "null" }];
    useDocs.getState().add([info(1)]);
    requestClose();
    await vi.waitFor(() => expect(currentUnsaved()?.docs.map((d) => d.id)).toEqual([5]));
    expect(names()).not.toContain("close_window");
    answerUnsaved("cancel");
    await tick();
    expect(names()).not.toContain("close_window");
    expect(useDocs.getState().docs.map((d) => d.id)).toEqual([1, 5]);
  });

  it("pedidos repetidos perguntam uma vez só", async () => {
    useDocs.getState().add([dirty(1)]);
    requestClose();
    requestClose();
    events["close-window"].cb({ payload: null });
    await asked();
    answerUnsaved("cancel");
    await tick();
    expect(currentUnsaved()).toBeNull();
  });

  it("se o Rust não fechar, a janela volta ao normal e o erro aparece", async () => {
    handlers.close_window = () => Promise.reject(new Error("x"));
    requestClose();
    await vi.waitFor(() => expect(toast).toHaveBeenCalled());
    expect(names()).toContain("unseal_window");
    expect(useTabs.getState().veil).toBeNull();
  });

  it("texto em edição conta como alteração", async () => {
    useDocs.getState().add([info(1)]);
    const input = document.body.appendChild(document.createElement("input"));
    input.addEventListener("blur", () => useDocs.getState().update(info(1, { dirty: true, rev: 1 })));
    input.focus();
    requestClose();
    await asked();
    answerUnsaved("cancel");
    input.remove();
  });
});

describe("sair e reiniciar", () => {
  it("só sai depois que todas as janelas concordam", async () => {
    handlers.confirm_quit = () => false;
    await quit();
    expect(names()).toEqual(["confirm_quit"]);
    handlers.confirm_quit = () => true;
    await quit();
    expect(names()).toEqual(["confirm_quit", "confirm_quit", "quit_app"]);
  });

  it("saída que falha devolve as janelas", async () => {
    handlers.confirm_quit = () => true;
    handlers.quit_app = () => Promise.reject(new Error("x"));
    await expect(quit()).rejects.toThrow();
    expect(names()).toContain("cancel_quit");
  });

  it("a janela perguntada responde, sem fechar", async () => {
    useDocs.getState().add([dirty(1)]);
    events["confirm-close"].cb({ payload: null });
    await asked();
    answerUnsaved("discard");
    await vi.waitFor(() => expect(calls).toContainEqual(["answer_close", { ok: true }]));
    expect(names()).not.toContain("close_window");
    expect(useTabs.getState().veil).toBe("closing");
    // Outra janela cancelou: o documento continua aqui, com as alterações.
    events["quit-cancelled"].cb({ payload: null });
    expect(useTabs.getState().veil).toBeNull();
    expect(useDocs.getState().docs[0].dirty).toBe(true);
  });

  it("Cancelar (ou falha) responde não", async () => {
    useDocs.getState().add([dirty(1)]);
    events["confirm-close"].cb({ payload: null });
    await asked();
    answerUnsaved("cancel");
    await vi.waitFor(() => expect(calls).toContainEqual(["answer_close", { ok: false }]));
    calls.length = 0;
    resetDocsForTests();
    handlers.seal_window = () => Promise.reject(new Error("x"));
    events["confirm-close"].cb({ payload: null });
    await vi.waitFor(() => expect(calls).toContainEqual(["answer_close", { ok: false }]));
    expect(useTabs.getState().veil).toBeNull();
  });

  it("reiniciar para atualizar pergunta antes e desfaz se não reiniciar", async () => {
    const relaunch = (handlers.relaunch = vi.fn(() => Promise.resolve()));
    handlers.confirm_quit = () => false;
    expect(await restartApp()).toBe(false);
    expect(relaunch).not.toHaveBeenCalled();
    handlers.confirm_quit = () => true;
    expect(await restartApp()).toBe(true);
    handlers.relaunch = () => Promise.reject(new Error("x"));
    await expect(restartApp()).rejects.toThrow();
    expect(names()).toContain("cancel_quit");
  });
});

describe("Fechar Todas", () => {
  it("fecha os documentos daqui e depois pede às outras janelas", async () => {
    useDocs.getState().add([info(1)]);
    runCommand("file.closeAll");
    await vi.waitFor(() => expect(names()).toEqual(["close_document", "close_other_windows"]));
  });

  it("Cancelar aqui não chega às outras", async () => {
    useDocs.getState().add([dirty(1)]);
    runCommand("file.closeAll");
    await asked();
    answerUnsaved("cancel");
    await tick();
    expect(names()).toEqual([]);
  });
});

describe("eventos da janela", () => {
  it("ouve só os mandados a ela", () => {
    expect(Object.values(events).map((e) => e.target)).toEqual(Object.keys(events).map(() => "doc-2"));
    expect(Object.keys(events)).toContain("merge-request");
  });

  it("o título segue o documento ativo", () => {
    useDocs.getState().add([info(1), info(2)]);
    useDocs.getState().setActive(2);
    const titles = calls.filter(([c]) => c === "set_window_title").map(([, a]) => (a as { title: string }).title);
    expect(titles).toEqual(["1.png", "2.png"]);
  });

  it("ativa o documento pedido por outra janela, se ainda estiver aqui", () => {
    useDocs.getState().add([info(1), info(2)]);
    events["activate-document"].cb({ payload: 2 });
    expect(useDocs.getState().activeId).toBe(2);
    events["activate-document"].cb({ payload: 99 });
    expect(useDocs.getState().activeId).toBe(2);
  });
});

describe("abrir arquivo já aberto em outra janela", () => {
  const win = (label: string) => ({ label, title: label });

  it("com uma janela só, abre direto", async () => {
    handlers.open_documents = () => [info(1)];
    await openHere(["/p/1.png"]);
    expect(calls).toContainEqual(["open_documents", { paths: ["/p/1.png"] }]);
    expect(names()).not.toContain("focus_open_paths");
  });

  it("com outras, abre só os que faltam", async () => {
    useTabs.setState({ windows: [win("main"), win("doc-1")] });
    handlers.focus_open_paths = () => ["/p/2.png"];
    handlers.open_documents = () => [info(2)];
    expect((await openHere(["/p/1.png", "/p/2.png"])).map((d) => d.id)).toEqual([2]);
    expect(calls).toContainEqual(["open_documents", { paths: ["/p/2.png"] }]);
    handlers.focus_open_paths = () => [];
    expect(await openHere(["/p/1.png"])).toEqual([]);
  });
});
