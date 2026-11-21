// "Recarregar" na faixa de arquivo alterado no disco: pergunta antes de descartar o não salvo.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocInfo } from "../ipc/types";

const ipc = vi.hoisted(() => ({
  revert: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  ignoreDiskChange: vi.fn(async () => {}),
}));
vi.mock("../ipc/commands", () => ipc);
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

import { useDocs } from "../store/docs";
import { DiskBanner } from "./DiskBanner";
import { useFileUi } from "./fileActions";
import { resetUnsavedForTests } from "./unsaved";
import { UnsavedDialog } from "./UnsavedDialog";

const doc = (dirty: boolean): DocInfo => ({
  id: 3, path: "/f/a.png", name: "a.png", format: "png", width: 4, height: 4, frames: 1,
  writable: true, dirty, canUndo: dirty, canRedo: false, rev: 1, error: null,
});

const setup = (dirty: boolean) => {
  useDocs.setState({ docs: [doc(dirty)], activeId: 3 });
  useFileUi.setState({ dialog: null, changed: { 3: false } });
  render(
    <>
      <DiskBanner />
      <UnsavedDialog />
    </>,
  );
};
const clickBannerReload = () =>
  act(async () => fireEvent.click(within(screen.getByTestId("disk-banner")).getByRole("button", { name: "Recarregar" })));

beforeEach(() => {
  vi.clearAllMocks();
  resetUnsavedForTests();
  ipc.revert.mockImplementation(async () => doc(false));
});
afterEach(cleanup);

describe("Recarregar", () => {
  it("sem alterações não salvas, recarrega direto", async () => {
    setup(false);
    await clickBannerReload();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(ipc.revert).toHaveBeenCalledWith(3, "lastSaved");
  });

  it("com alterações, pergunta; Cancelar mantém e confirmar descarta e recarrega", async () => {
    setup(true);
    await clickBannerReload();
    let dlg = await screen.findByRole("alertdialog");
    expect(dlg.textContent).toContain("a.png");
    // Salvar por cima de um arquivo alterado fora do app não é opção aqui.
    expect(within(dlg).queryByRole("button", { name: "Salvar" })).toBeNull();
    await act(async () => fireEvent.click(within(dlg).getByRole("button", { name: "Cancelar" })));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(ipc.revert).not.toHaveBeenCalled();

    await clickBannerReload();
    dlg = await screen.findByRole("alertdialog");
    await act(async () => fireEvent.click(within(dlg).getByRole("button", { name: "Recarregar" })));
    expect(ipc.revert).toHaveBeenCalledWith(3, "lastSaved");
  });
});
