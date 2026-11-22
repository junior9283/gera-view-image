import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo } from "../ipc/types";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({}) }));

import { resetDocsForTests, useDocs } from "../store/docs";
import { resetPrefsForTests, setPrefs } from "../store/prefs";
import { resetUiForTests, useUi } from "../store/ui";
import { resetUnsavedForTests } from "../file/unsaved";
import { activate } from "./actions";
import { back, canBack, canForward, forward, installHistory } from "./history";

const info = (id: number, extra: Partial<DocInfo> = {}): DocInfo => ({
  id, path: `/pasta/${id}.png`, name: `${id}.png`, format: "png", width: 40, height: 30, frames: 1,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 0, error: null, ...extra,
});

const active = () => useDocs.getState().activeId;
/** As mudanças são registradas num microtask (activate troca página e documento em dois passos). */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

let uninstall: () => void;

beforeEach(() => {
  invoke.mockReset();
  resetDocsForTests();
  resetPrefsForTests();
  resetUiForTests();
  resetUnsavedForTests();
  uninstall = installHistory();
});

afterEach(() => uninstall());

describe("Voltar / Avançar", () => {
  beforeEach(async () => {
    useDocs.getState().add([info(1), info(2), info(3)]);
    await flush();
  });

  it("sem histórico, nada a fazer", () => {
    expect(canBack()).toBe(false);
    expect(canForward()).toBe(false);
  });

  it("volta e avança pelos documentos visitados, na ordem da visita", async () => {
    activate(3);
    await flush();
    activate(2);
    await flush();
    expect(canBack()).toBe(true);
    await back();
    expect(active()).toBe(3);
    await back();
    expect(active()).toBe(1);
    expect(canBack()).toBe(false);
    expect(canForward()).toBe(true);
    await forward();
    expect(active()).toBe(3);
    await forward();
    expect(active()).toBe(2);
    expect(canForward()).toBe(false);
  });

  it("visitar outro depois de voltar descarta o Avançar", async () => {
    activate(2);
    await flush();
    await back();
    activate(3);
    await flush();
    expect(canForward()).toBe(false);
    await back();
    expect(active()).toBe(1);
  });

  it("lembra a página de cada visita", async () => {
    activate(1, 4);
    await flush();
    activate(2);
    await flush();
    await back();
    expect(active()).toBe(1);
    expect(useUi.getState().page).toBe(4);
  });

  it("pula os documentos que foram fechados", async () => {
    activate(2);
    await flush();
    activate(3);
    await flush();
    await useDocs.getState().close(2);
    await flush();
    expect(active()).toBe(3);
    await back();
    expect(active()).toBe(1);
  });

  it("não volta para fechados quando há vários abertos", async () => {
    activate(2);
    await flush();
    await useDocs.getState().close(1);
    await flush();
    expect(canBack()).toBe(false);
  });
});

describe("navegando pela pasta (um só documento aberto)", () => {
  it("reabre o arquivo anterior e fecha o atual", async () => {
    setPrefs({ browseFolder: true });
    useDocs.getState().add([info(1)]);
    await flush();
    // Seta → abre o vizinho e fecha o anterior (o que `go.next` faz pela pasta).
    useDocs.getState().add([info(2)]);
    activate(2);
    await useDocs.getState().close(1);
    await flush();
    invoke.mockImplementation(async (cmd: string) => (cmd === "open_documents" ? [info(5, { path: "/pasta/1.png" })] : undefined));
    expect(canBack()).toBe(true);
    await back();
    expect(invoke).toHaveBeenCalledWith("open_documents", { paths: ["/pasta/1.png"] });
    expect(useDocs.getState().docs.map((d) => d.id)).toEqual([5]);
    expect(active()).toBe(5);
    expect(canForward()).toBe(true);
  });
});
