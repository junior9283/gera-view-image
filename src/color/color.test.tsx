import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo } from "../ipc/types";

const ipc = vi.hoisted(() => ({
  listProfiles: vi.fn(async () => [
    { id: "srgb", name: "sRGB IEC61966-2.1" },
    { id: "display-p3", name: "Display P3" },
    { id: "adobe-rgb", name: "Adobe RGB (1998)" },
  ]),
  metadata: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ general: { profile: "Display P3" } })),
  applyOp: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  setColorManagement: vi.fn(async () => {}),
}));
vi.mock("../ipc/commands", () => ipc);

import { Slot } from "../lib/slots";
import { isEnabled, runCommand } from "../shortcuts/commands";
import { useDocs } from "../store/docs";
import { setPrefs } from "../store/prefs";
import "./register";

const doc: DocInfo = {
  id: 7, path: "/f/p3.png", name: "p3.png", format: "png", width: 4, height: 3, frames: 1, delaysMs: [], plays: 0,
  writable: true, dirty: false, canUndo: false, canRedo: false, rev: 1, error: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  setPrefs({ language: "pt-BR" });
  useDocs.setState({ docs: [doc], activeId: 7 });
});
afterEach(cleanup);

describe("Atribuir Perfil…", () => {
  it("só habilita com documento visível", () => {
    expect(isEnabled("tools.assignProfile")).toBe(true);
    useDocs.setState({ docs: [{ ...doc, error: "corrupt" }] });
    expect(isEnabled("tools.assignProfile")).toBe(false);
  });

  it("lista os perfis, pré-seleciona o atual e aplica a operação", async () => {
    ipc.applyOp.mockResolvedValue({ ...doc, rev: 2, dirty: true, canUndo: true });
    render(<Slot name="above-content" props={{}} />);
    act(() => void runCommand("tools.assignProfile"));
    expect(await screen.findByText(/Perfil atual: Display P3/)).toBeTruthy();
    const select = (await screen.findByTestId("assign-profile")) as HTMLSelectElement;
    await vi.waitFor(() => expect(select.value).toBe("display-p3"));
    fireEvent.change(select, { target: { value: "adobe-rgb" } });
    await act(async () => fireEvent.click(screen.getByText("Atribuir")));
    expect(ipc.applyOp).toHaveBeenCalledWith(7, { type: "assignProfile", data: { profile: "adobe-rgb" } });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useDocs.getState().docs[0].rev).toBe(2);
  });

  it("mostra o erro e continua aberto se a operação falhar", async () => {
    ipc.metadata.mockResolvedValueOnce({ general: { profile: null } });
    ipc.applyOp.mockRejectedValue(new Error("x"));
    render(<Slot name="above-content" props={{}} />);
    act(() => void runCommand("tools.assignProfile"));
    expect(await screen.findByText(/nenhum \(sRGB presumido\)/)).toBeTruthy();
    await screen.findByTestId("assign-profile");
    await act(async () => fireEvent.click(screen.getByText("Atribuir")));
    expect((await screen.findByRole("alert")).textContent).toContain("Não foi possível");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("preferência de correspondência de cor", () => {
  it("avisa o Rust só quando o valor muda", () => {
    setPrefs({ colorManagement: false });
    setPrefs({ language: "en" });
    expect(ipc.setColorManagement).toHaveBeenCalledTimes(1);
    expect(ipc.setColorManagement).toHaveBeenCalledWith(false);
    setPrefs({ colorManagement: true });
    expect(ipc.setColorManagement).toHaveBeenLastCalledWith(true);
    expect(ipc.setColorManagement).toHaveBeenCalledTimes(2);
  });
});
