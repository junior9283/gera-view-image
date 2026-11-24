// L5: Arquivo › Importar do Scanner (`scanimage` externo).
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo, ScanOptions } from "../ipc/types";

const ipc = vi.hoisted(() => ({
  scanAvailable: vi.fn<() => Promise<boolean>>(),
  scanDevices: vi.fn<() => Promise<{ name: string; label: string }[] | null>>(),
  scanOptions: vi.fn<(device: string) => Promise<ScanOptions | null>>(),
  scanImage: vi.fn<(...a: unknown[]) => Promise<DocInfo | null>>(),
  scanCancel: vi.fn(async () => {}),
  closeDocument: vi.fn(async () => {}),
}));
vi.mock("../ipc/commands", () => ipc);

import { commandState } from "../shortcuts/commandState";
import { isEnabled, runCommand } from "../shortcuts/commands";
import { resetDocsForTests, useDocs } from "../store/docs";
import { resetPrefsForTests, setPrefs } from "../store/prefs";
import { ScanDialog } from "./ScanDialog";
import { registerScanner } from "./scan";

const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));
const scanned = {
  id: 7, path: "", name: "Sem título", format: "png", width: 236, height: 295, frames: 1,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 0, error: null,
} as DocInfo;
const OPTIONS: ScanOptions = { modes: ["color", "gray"], resolutions: [75, 150, 300, 600], resolution: 300 };

let off: (() => void) | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  resetDocsForTests();
  resetPrefsForTests();
  setPrefs({ language: "pt-BR" });
  ipc.scanAvailable.mockResolvedValue(true);
  ipc.scanDevices.mockResolvedValue([
    { name: "test:0", label: "Noname frontend-tester" },
    { name: "epson2:net:10.0.0.9", label: "Epson Perfection" },
  ]);
  ipc.scanOptions.mockResolvedValue(OPTIONS);
  ipc.scanImage.mockResolvedValue(scanned);
});
afterEach(() => {
  off?.();
  off = undefined;
  cleanup();
});

async function openDialog() {
  off = registerScanner();
  await flush();
  render(createElement(ScanDialog));
  await act(async () => void runCommand("file.importScanner"));
  await flush();
}

describe("Importar do Scanner", () => {
  it("sem scanimage no PATH: item desabilitado com dica", async () => {
    ipc.scanAvailable.mockResolvedValue(false);
    off = registerScanner();
    await flush();
    expect(isEnabled("file.importScanner")).toBe(false);
    expect(commandState("file.importScanner").title).toBe("scan.missing");
  });

  it("com scanimage: habilitado e sem dica", async () => {
    off = registerScanner();
    await flush();
    expect(isEnabled("file.importScanner")).toBe(true);
    expect(commandState("file.importScanner").title).toBeUndefined();
  });

  it("digitaliza com o dispositivo, modo e resolução escolhidos e abre como Sem título", async () => {
    await openDialog();
    expect(screen.getByRole("dialog", { name: "Importar do Scanner" })).toBeTruthy();
    expect(ipc.scanOptions).toHaveBeenCalledWith("test:0");
    fireEvent.change(screen.getByLabelText("Dispositivo"), { target: { value: "epson2:net:10.0.0.9" } });
    await flush();
    expect(ipc.scanOptions).toHaveBeenLastCalledWith("epson2:net:10.0.0.9");
    const mode = screen.getByLabelText("Modo") as HTMLSelectElement;
    expect([...mode.options].map((o) => o.text)).toEqual(["Cor", "Tons de cinza"]);
    fireEvent.change(mode, { target: { value: "gray" } });
    const dpi = screen.getByLabelText("Resolução") as HTMLSelectElement;
    expect(dpi.value).toBe("300");
    fireEvent.change(dpi, { target: { value: "600" } });
    fireEvent.click(screen.getByRole("button", { name: "Digitalizar" }));
    await flush();
    expect(ipc.scanImage).toHaveBeenCalledWith("epson2:net:10.0.0.9", "gray", 600, "Sem título");
    expect(useDocs.getState().activeId).toBe(7);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("sem dispositivo: erro claro e nada para digitalizar", async () => {
    ipc.scanDevices.mockResolvedValue([]);
    await openDialog();
    expect(screen.getByRole("alert").textContent).toBe("Nenhum scanner encontrado.");
    expect((screen.getByRole("button", { name: "Digitalizar" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Cancelar durante a digitalização mata o processo e fecha", async () => {
    let finish: (v: DocInfo | null) => void = () => {};
    ipc.scanImage.mockImplementation(() => new Promise((r) => (finish = r)));
    await openDialog();
    fireEvent.click(screen.getByRole("button", { name: "Digitalizar" }));
    await flush();
    expect(screen.getByRole("status").textContent).toBe("Digitalizando…");
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(ipc.scanCancel).toHaveBeenCalled();
    await act(async () => finish(null));
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useDocs.getState().docs).toEqual([]);
  });

  it("Cancelar quando a digitalização já acabou (decodificando) fecha o documento que chega", async () => {
    let finish: (v: DocInfo | null) => void = () => {};
    ipc.scanImage.mockImplementation(() => new Promise((r) => (finish = r)));
    await openDialog();
    fireEvent.click(screen.getByRole("button", { name: "Digitalizar" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    await act(async () => finish(scanned));
    await flush();
    expect(ipc.closeDocument).toHaveBeenCalledWith(scanned.id);
    expect(useDocs.getState().docs).toEqual([]);
  });

  it("erro do scanimage e tempo esgotado aparecem no diálogo", async () => {
    ipc.scanImage.mockRejectedValueOnce({ code: "io", message: "open of device test:0 failed: Device busy" });
    await openDialog();
    fireEvent.click(screen.getByRole("button", { name: "Digitalizar" }));
    await flush();
    expect(screen.getByRole("alert").textContent).toBe(
      "Não foi possível digitalizar: open of device test:0 failed: Device busy",
    );
    ipc.scanImage.mockRejectedValueOnce({ code: "io", message: "timeout" });
    fireEvent.click(screen.getByRole("button", { name: "Digitalizar" }));
    await flush();
    expect(screen.getByRole("alert").textContent).toBe("O scanner demorou demais e a digitalização foi interrompida.");
    ipc.scanImage.mockRejectedValueOnce({ code: "too_large", message: "512" });
    fireEvent.click(screen.getByRole("button", { name: "Digitalizar" }));
    await flush();
    expect(screen.getByRole("alert").textContent).toBe("A digitalização é grande demais (o limite é 512 MiB).");
  });

  it("lendo as opções do dispositivo, o estado é anunciado", async () => {
    let finish: (v: ScanOptions | null) => void = () => {};
    ipc.scanOptions.mockImplementation(() => new Promise((r) => (finish = r)));
    await openDialog();
    expect(screen.getByRole("status").textContent).toBe("Lendo as opções do scanner…");
    await act(async () => finish(OPTIONS));
    await flush();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("opções canceladas (null) não deixam o diálogo ocupado para sempre", async () => {
    ipc.scanOptions.mockResolvedValueOnce(null);
    await openDialog();
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-busy")).toBe("false");
    expect(screen.queryByRole("status")).toBeNull();
    // Escolher de novo o dispositivo volta a ler as opções.
    fireEvent.change(screen.getByLabelText("Dispositivo"), { target: { value: "epson2:net:10.0.0.9" } });
    await flush();
    expect((screen.getByRole("button", { name: "Digitalizar" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("busca de dispositivos cancelada (null) não deixa o diálogo ocupado", async () => {
    ipc.scanDevices.mockResolvedValueOnce(null);
    await openDialog();
    expect(screen.getByRole("dialog").getAttribute("aria-busy")).toBe("false");
    expect(screen.queryByRole("status")).toBeNull();
  });
});
