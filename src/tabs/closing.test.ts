import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const setFocus = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "doc-2",
    onCloseRequested: async (cb: typeof onClose) => ((onClose = cb), () => {}),
    setFocus,
  }),
}));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: () => handlers.relaunch?.() ?? Promise.resolve() }));
const toast = vi.hoisted(() => vi.fn());
vi.mock("../chrome/notify", () => ({ notify: toast, notifyError: toast }));

import { answerUnsaved, currentUnsaved, resetUnsavedForTests, setSaveHandler } from "../file/unsaved";
import { track } from "../ipc/inflight";
import { runCommand } from "../shortcuts/commands";
import { resetDocsForTests, useDocs } from "../store/docs";
import { resetPrefsForTests } from "../store/prefs";
import { restartApp } from "../updater/updater";
import { quit, resetClosingForTests } from "./closing";
import { openHere } from "./open";
import { answerQuestion, putVeil, resetTabsForTests, useTabs } from "./store";
import { moveTabToNewWindow } from "./transfer";
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

afterEach(() => {
  vi.useRealTimers();
  resetTabsForTests();
});

beforeEach(() => {
  for (const k of Object.keys(handlers)) delete handlers[k];
  handlers.seal_window = () => true;
  calls.length = 0;
  toast.mockReset();
  resetDocsForTests();
  resetTabsForTests();
  resetPrefsForTests();
  resetUnsavedForTests();
  resetClosingForTests();
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

  it("editado durante a gravação lenta de outro: é perguntado de novo", async () => {
    useDocs.getState().add([dirty(1), dirty(2)]);
    let saveTwo!: () => void;
    setSaveHandler(async (d) => {
      if (d.id === 2) await new Promise<void>((r) => (saveTwo = r));
      useDocs.getState().update(info(d.id, { rev: 1 }));
      return true;
    });
    requestClose();
    await asked();
    answerUnsaved("save");
    await vi.waitFor(() => expect(saveTwo).toBeDefined());
    expect(useTabs.getState().veil, "nada se edita enquanto salva").toBe("saving");
    useDocs.getState().update(info(1, { dirty: true, rev: 2 }));
    saveTwo();
    await vi.waitFor(() => expect(currentUnsaved()?.docs.map((d) => d.id)).toEqual([1]));
    expect(names()).not.toContain("seal_window");
    expect(useTabs.getState().veil).toBeNull();
    answerUnsaved("cancel");
  });

  it("descartado que mudou durante a pergunta seguinte é perguntado de novo", async () => {
    useDocs.getState().add([dirty(1)]);
    requestClose();
    await asked();
    useDocs.getState().add([dirty(2)]);
    answerUnsaved("discard");
    await vi.waitFor(() => expect(currentUnsaved()?.docs.map((d) => d.id)).toEqual([2]));
    useDocs.getState().update(info(1, { dirty: true, rev: 1 }));
    answerUnsaved("discard");
    await vi.waitFor(() => expect(currentUnsaved()?.docs.map((d) => d.id)).toEqual([1]));
    expect(names()).not.toContain("seal_window");
    answerUnsaved("cancel");
  });

  it("com documento mudando de janela, espera terminar antes de selar", async () => {
    useDocs.getState().add([info(1), info(2)]);
    let moved!: () => void;
    handlers.new_window = () => new Promise<void>((r) => (moved = r));
    const move = moveTabToNewWindow();
    await vi.waitFor(() => expect(moved).toBeDefined());
    // Relógio falso: passa do prazo da operação em andamento (1,5 s) sem dormir de verdade.
    vi.useFakeTimers();
    requestClose();
    await vi.advanceTimersByTimeAsync(2000);
    vi.useRealTimers();
    expect(names()).not.toContain("seal_window");
    expect(useTabs.getState().question, "mover não é operação a interromper").toBeNull();
    expect(useTabs.getState().veil).toBe("moving");
    moved();
    await move;
    await vi.waitFor(() => expect(names()).toContain("close_window"));
  });

  it("o fim da saída de outra não destrava a janela que está fechando", async () => {
    let close!: () => void;
    handlers.close_window = () => new Promise<void>((r) => (close = r));
    requestClose();
    await vi.waitFor(() => expect(close).toBeDefined());
    events["quit-cancelled"].cb({ payload: 99 });
    expect(useTabs.getState().veil).toBe("closing");
    close();
  });

  describe("com impressão ou gravação em andamento", () => {
    const question = () => vi.waitFor(() => expect(useTabs.getState().question).not.toBeNull(), { timeout: 4000 });

    it("avisa; Esperar mantém a janela", async () => {
      let done!: () => void;
      void track("print_native", { ids: [1] }, new Promise<void>((r) => (done = r)));
      requestClose();
      await question();
      expect(names()).not.toContain("seal_window");
      answerQuestion(false);
      await tick();
      expect(useTabs.getState().question).toBeNull();
      expect(names()).not.toContain("seal_window");
      done();
    });

    it("termina sozinha se a operação acabar com o aviso aberto", async () => {
      let done!: () => void;
      void track("export_pdf", { ids: [1] }, new Promise<void>((r) => (done = r)));
      requestClose();
      await question();
      done();
      await vi.waitFor(() => expect(names()).toContain("close_window"));
      expect(useTabs.getState().question).toBeNull();
    });

    it("fechar assim mesmo é escolha explícita", async () => {
      let done!: () => void;
      void track("export_pdf", { ids: [1] }, new Promise<void>((r) => (done = r)));
      requestClose();
      await question();
      answerQuestion(true);
      await vi.waitFor(() => expect(names()).toContain("close_window"));
      done();
    });

    it("documento que começou a mudar de janela no meio disso também é esperado", async () => {
      useDocs.getState().add([info(1), info(2)]);
      let done!: () => void;
      void track("print_native", { ids: [9] }, new Promise<void>((r) => (done = r)));
      requestClose();
      await question();
      let moved!: () => void;
      handlers.new_window = () => new Promise<void>((r) => (moved = r));
      const move = moveTabToNewWindow();
      await vi.waitFor(() => expect(moved).toBeDefined());
      vi.useFakeTimers();
      answerQuestion(true);
      // Bem mais que as voltas de espera (30 ms cada): selar agora seria sem esperar a mudança de janela.
      await vi.advanceTimersByTimeAsync(2000);
      vi.useRealTimers();
      expect(names()).not.toContain("seal_window");
      moved();
      await move;
      await vi.waitFor(() => expect(names()).toContain("close_window"));
      done();
    });
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
  const agreed = () => ({ kind: "agreed" });

  it("só sai depois que todas as janelas concordam", async () => {
    handlers.confirm_quit = () => ({ kind: "cancelled" });
    await quit();
    expect(names()).toEqual(["confirm_quit"]);
    handlers.confirm_quit = agreed;
    await quit();
    expect(names()).toEqual(["confirm_quit", "confirm_quit", "quit_app"]);
  });

  const hung = { kind: "unresponsive", label: "doc-7", title: "presa.png" };

  it("janela que não responde: o padrão é cancelar, sem sair nem descartar", async () => {
    handlers.confirm_quit = () => hung;
    const leaving = quit();
    await vi.waitFor(() => expect(useTabs.getState().question?.body).toContain("presa.png"));
    expect(names()).toEqual(["confirm_quit"]);
    answerQuestion(false);
    expect(await leaving).toBe(false);
    expect(names()).toEqual(["confirm_quit"]);
  });

  it("janela que não responde: só sai sem ela com a escolha explícita", async () => {
    const outcomes = [hung, { kind: "agreed" }];
    handlers.confirm_quit = () => outcomes.shift();
    const leaving = quit();
    await vi.waitFor(() => expect(useTabs.getState().question).not.toBeNull());
    answerQuestion(true);
    expect(await leaving).toBe(true);
    expect(calls.filter(([c]) => c === "confirm_quit").map(([, a]) => a)).toEqual([{ skip: [] }, { skip: ["doc-7"] }]);
  });

  it("janela ainda abrindo com imagens: avisa em vez de desistir calado", async () => {
    handlers.confirm_quit = () => ({ kind: "opening", title: "praia.png" });
    expect(await quit()).toBe(false);
    expect(toast.mock.calls[0][0]).toContain("praia.png");
    expect(names()).not.toContain("quit_app");
  });

  it("responde ao ping na hora", () => {
    events["ping-window"].cb({ payload: 5 });
    expect(calls).toContainEqual(["pong", { n: 5 }]);
  });

  it("a saída cancelada numa rodada antiga não destrava a nova", async () => {
    events["confirm-close"].cb({ payload: 2 });
    await vi.waitFor(() => expect(useTabs.getState().veil).toBe("quitting"));
    events["quit-cancelled"].cb({ payload: 1 });
    expect(useTabs.getState().veil).toBe("quitting");
    events["quit-cancelled"].cb({ payload: 2 });
    expect(useTabs.getState().veil).toBeNull();
  });

  it("o véu de mover não cai com a saída cancelada", () => {
    const release = putVeil("moving");
    events["quit-cancelled"].cb({ payload: 9 });
    expect(useTabs.getState().veil).toBe("moving");
    release();
    expect(useTabs.getState().veil).toBeNull();
  });

  it("saída que falha devolve as janelas", async () => {
    handlers.confirm_quit = agreed;
    handlers.quit_app = () => Promise.reject(new Error("x"));
    await expect(quit()).rejects.toThrow();
    expect(names()).toContain("cancel_quit");
  });

  it("a janela perguntada responde, sem fechar", async () => {
    useDocs.getState().add([dirty(1)]);
    events["confirm-close"].cb({ payload: 1 });
    await asked();
    answerUnsaved("discard");
    await vi.waitFor(() => expect(calls).toContainEqual(["answer_close", { round: 1, ok: true }]));
    expect(names()).not.toContain("close_window");
    expect(setFocus, "trazer para a frente é do Rust").not.toHaveBeenCalled();
    expect(useTabs.getState().veil).toBe("quitting");
    // Outra janela cancelou: o documento continua aqui, com as alterações.
    events["quit-cancelled"].cb({ payload: 1 });
    expect(useTabs.getState().veil).toBeNull();
    expect(useDocs.getState().docs[0].dirty).toBe(true);
  });

  it("perguntada de novo com a pergunta aberta, responde uma vez só", async () => {
    useDocs.getState().add([dirty(1)]);
    events["confirm-close"].cb({ payload: 1 });
    await asked();
    events["confirm-close"].cb({ payload: 2 });
    answerUnsaved("discard");
    await vi.waitFor(() => expect(names()).toContain("answer_close"));
    await tick();
    expect(names().filter((c) => c === "answer_close")).toHaveLength(1);
    expect(calls).toContainEqual(["answer_close", { round: 2, ok: true }]);
  });

  it("Cancelar (ou falha) responde não", async () => {
    useDocs.getState().add([dirty(1)]);
    events["confirm-close"].cb({ payload: 1 });
    await asked();
    answerUnsaved("cancel");
    await vi.waitFor(() => expect(calls).toContainEqual(["answer_close", { round: 1, ok: false }]));
    calls.length = 0;
    resetDocsForTests();
    handlers.seal_window = () => Promise.reject(new Error("x"));
    events["confirm-close"].cb({ payload: 1 });
    await vi.waitFor(() => expect(calls).toContainEqual(["answer_close", { round: 1, ok: false }]));
    expect(useTabs.getState().veil).toBeNull();
  });

  it("reiniciar para atualizar pergunta antes e desfaz se não reiniciar", async () => {
    const relaunch = (handlers.relaunch = vi.fn(() => Promise.resolve()));
    handlers.confirm_quit = () => ({ kind: "cancelled" });
    expect(await restartApp()).toBe(false);
    expect(relaunch).not.toHaveBeenCalled();
    handlers.confirm_quit = agreed;
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

  it("diz qual janela não pôde ser juntada", () => {
    events["merge-declined"].cb({ payload: "praia.png" });
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("praia.png"));
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
