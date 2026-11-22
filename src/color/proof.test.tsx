// Prova de Cor com Perfil (L12): submenu, escolha de arquivo, por documento e acompanhando a aba.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ColorProfile, DocInfo } from "../ipc/types";

const ipc = vi.hoisted(() => ({
  listProofProfiles: vi.fn<() => Promise<ColorProfile[]>>(),
  setProofProfile: vi.fn<(id: number, p: string | null) => Promise<ColorProfile | null>>(),
}));
vi.mock("../ipc/commands", () => ipc);
const dialog = vi.hoisted(() => ({ open: vi.fn<(...a: unknown[]) => Promise<string | null>>() }));
vi.mock("@tauri-apps/plugin-dialog", () => dialog);

import { MenuBar } from "../chrome/MenuBar";
import { getToasts, resetToastsForTests } from "../chrome/notify";
import { dropDocs, dumpDocs, loadDocs } from "../lib/docState";
import { isEnabled, runCommand } from "../shortcuts/commands";
import { useDocs } from "../store/docs";
import { setPrefs } from "../store/prefs";
import { proofOf, resetProofForTests } from "./proof";

const doc = (id: number): DocInfo => ({
  id, path: `/fotos/Ação ${id}.jpg`, name: `Ação ${id}.jpg`, format: "jpeg", width: 40, height: 20, frames: 1,
  delaysMs: [], plays: 0, writable: true, dirty: false, canUndo: false, canRedo: false, rev: 1, error: null,
});
const PROFILES: ColorProfile[] = [
  { id: "srgb", name: "sRGB IEC61966-2.1" },
  { id: "/usr/share/color/icc/papel.icc", name: "Papel não revestido" },
];

async function openSubmenu() {
  fireEvent.click(screen.getByRole("menuitem", { name: "Visualizar" }));
  await act(async () => fireEvent.mouseEnter(screen.getByRole("menuitem", { name: /Prova de Cor com Perfil/ })));
}
// Só o submenu aberto (o menu Visualizar também tem itens de rádio, como a barra lateral).
const radios = () =>
  within(screen.getAllByRole("menu").slice(-1)[0])
    .getAllByRole("menuitemradio")
    .map((r) => [r.textContent, r.getAttribute("aria-checked")]);

beforeEach(() => {
  vi.clearAllMocks();
  resetProofForTests();
  resetToastsForTests();
  setPrefs({ language: "pt-BR" });
  useDocs.setState({ docs: [doc(1), doc(2)], activeId: 1 });
  ipc.listProofProfiles.mockResolvedValue(PROFILES);
  ipc.setProofProfile.mockImplementation(async (_id, p) => {
    if (p === null) return null;
    return PROFILES.find((x) => x.id === p) ?? { id: p, name: "Gráfica" };
  });
});
afterEach(cleanup);

describe("Prova de Cor com Perfil", () => {
  it("lista Nenhum, os perfis instalados e Escolher; marca o do documento", async () => {
    render(<MenuBar />);
    await openSubmenu();
    expect(radios()).toEqual([["Nenhum", "true"], ["sRGB IEC61966-2.1", "false"], ["Papel não revestido", "false"]]);
    expect(screen.getByRole("menuitem", { name: /Escolher Perfil…/ })).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("menuitemradio", { name: "Papel não revestido" })));
    expect(ipc.setProofProfile).toHaveBeenCalledWith(1, PROFILES[1].id);
    await openSubmenu();
    expect(radios()[2]).toEqual(["Papel não revestido", "true"]);
    expect(radios()[0]).toEqual(["Nenhum", "false"]);
    expect(ipc.listProofProfiles).toHaveBeenCalledTimes(1);
    // Vale por documento.
    act(() => useDocs.setState({ activeId: 2 }));
    expect(proofOf(2)).toBeNull();
    expect(proofOf(1)).toEqual(PROFILES[1]);
  });

  it("Nenhum volta ao normal; escolher arquivo entra na lista; cancelar não muda nada", async () => {
    dialog.open.mockResolvedValue("/casa/Gráfica.icc");
    await act(async () => void runCommand("view.softProofChoose"));
    expect(ipc.setProofProfile).toHaveBeenLastCalledWith(1, "/casa/Gráfica.icc");
    render(<MenuBar />);
    await openSubmenu();
    expect(radios().slice(-1)[0]).toEqual(["Gráfica", "true"]);
    await act(async () => fireEvent.click(screen.getByRole("menuitemradio", { name: "Nenhum" })));
    expect(ipc.setProofProfile).toHaveBeenLastCalledWith(1, null);
    expect(proofOf(1)).toBeNull();
    dialog.open.mockResolvedValue(null);
    await act(async () => void runCommand("view.softProofChoose"));
    expect(ipc.setProofProfile).toHaveBeenCalledTimes(2);
  });

  it("perfil recusado avisa e mantém o atual", async () => {
    await act(async () => void runCommand("view.softProofNone"));
    ipc.setProofProfile.mockRejectedValue({ code: "unsupported", message: "perfil de cor inválido" });
    dialog.open.mockResolvedValue("/casa/ruim.icc");
    await act(async () => void runCommand("view.softProofChoose"));
    expect(proofOf(1)).toBeNull();
    expect(getToasts()).toHaveLength(1);
  });

  it("falha ao listar tenta de novo na próxima abertura", async () => {
    ipc.listProofProfiles.mockRejectedValueOnce({ code: "io", message: "x" });
    render(<MenuBar />);
    await openSubmenu();
    expect(radios()).toEqual([["Nenhum", "true"]]);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    fireEvent.mouseDown(document.body);
    await openSubmenu();
    expect(radios()).toHaveLength(3);
  });

  it("funciona pelo teclado", async () => {
    render(<MenuBar />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Visualizar" }));
    const item = screen.getByRole("menuitem", { name: /Prova de Cor com Perfil/ });
    item.focus();
    await act(async () => fireEvent.keyDown(item, { key: "ArrowRight" }));
    expect(document.activeElement?.textContent).toBe("Nenhum");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe("sRGB IEC61966-2.1");
    await act(async () => fireEvent.keyDown(document.activeElement!, { key: "Enter" }));
    expect(ipc.setProofProfile).toHaveBeenCalledWith(1, "srgb");
  });

  it("acompanha o documento que muda de janela e some da origem", async () => {
    await act(async () => void runCommand("view.softProofNone"));
    ipc.setProofProfile.mockResolvedValue(PROFILES[1]);
    dialog.open.mockResolvedValue(PROFILES[1].id);
    await act(async () => void runCommand("view.softProofChoose"));
    const state = JSON.parse(JSON.stringify(dumpDocs([1])));
    dropDocs([1]);
    expect(proofOf(1)).toBeNull();
    loadDocs(state);
    expect(proofOf(1)).toEqual(PROFILES[1]);
  });

  it("sem imagem legível fica desabilitado", () => {
    useDocs.setState({ docs: [{ ...doc(1), error: "corrupt" }], activeId: 1 });
    expect(isEnabled("view.softProofNone")).toBe(false);
    expect(isEnabled("view.softProofChoose")).toBe(false);
  });
});
