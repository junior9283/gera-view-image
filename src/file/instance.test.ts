// L2: arquivos pedidos por outra execução do app chegam a esta janela e abrem por `openFiles`.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => void>(),
  take: vi.fn<() => Promise<string[]>>(),
  openFiles: vi.fn<(paths: string[]) => Promise<void>>(),
  notifyError: vi.fn(),
}));
vi.mock("../lib/window", () => ({
  listenHere: async (event: string, f: (p: unknown) => void) => {
    h.handlers.set(event, f);
    return () => h.handlers.delete(event);
  },
}));
vi.mock("../ipc/commands", () => ({ takeOpenRequests: h.take }));
vi.mock("./openFiles", () => ({ openFiles: h.openFiles }));
vi.mock("../chrome/notify", () => ({ notifyError: h.notifyError }));

import { OPEN_REQUEST_EVENT } from "../ipc/types";
import { registerOpenRequests } from "./instance";

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  h.handlers.clear();
  h.take.mockReset();
  h.openFiles.mockReset();
  h.openFiles.mockResolvedValue();
  h.notifyError.mockReset();
});

describe("pedidos de outra instância", () => {
  it("ao registrar, pega o que chegou antes de a janela ouvir", async () => {
    h.take.mockResolvedValueOnce(["/fotos/Ação 1.jpg"]);
    const off = registerOpenRequests();
    await flush();
    expect(h.openFiles).toHaveBeenCalledWith(["/fotos/Ação 1.jpg"]);
    off();
  });

  it("cada aviso retira a fila e abre conforme a preferência (openFiles)", async () => {
    h.take.mockResolvedValue([]);
    const off = registerOpenRequests();
    await flush();
    expect(h.openFiles).not.toHaveBeenCalled();
    h.take.mockResolvedValueOnce(["/a.png", "/b.png"]);
    h.handlers.get(OPEN_REQUEST_EVENT)?.(null);
    await flush();
    expect(h.openFiles).toHaveBeenCalledWith(["/a.png", "/b.png"]);
    off();
    expect(h.handlers.has(OPEN_REQUEST_EVENT)).toBe(false);
  });

  it("falha ao abrir vira aviso, não exceção solta", async () => {
    h.take.mockResolvedValueOnce(["/x.png"]);
    h.openFiles.mockRejectedValueOnce({ code: "io" });
    const off = registerOpenRequests();
    await flush();
    expect(h.notifyError).toHaveBeenCalled();
    off();
  });
});
