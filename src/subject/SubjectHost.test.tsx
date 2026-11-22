import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async () => undefined);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...(a as [])) }));

import { isRegistered } from "../shortcuts/commands";
import "../select/subject";
import { useSubject } from "./actions";
import { SubjectHost } from "./SubjectHost";

afterEach(cleanup);

describe("SubjectHost", () => {
  beforeEach(() => {
    invoke.mockClear();
    useSubject.setState({ phase: { kind: "idle" } });
  });

  it("o registro do lote liga Remover Fundo e Copiar Objeto", () => {
    expect(isRegistered("tools.removeBackground")).toBe(true);
    expect(isRegistered("tools.copySubject")).toBe(true);
  });

  it("parado não mostra nada", () => {
    const { container } = render(<SubjectHost />);
    expect(container.innerHTML).toBe("");
  });

  it("ocupado mostra a faixa e Cancelar avisa o backend", () => {
    useSubject.setState({ phase: { kind: "busy", downloading: true } });
    render(<SubjectHost />);
    expect(screen.getByTestId("subject-busy").textContent).toContain("Baixando o modelo de recorte");
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(useSubject.getState().phase.kind).toBe("idle");
    expect(invoke).toHaveBeenCalledWith("segment_cancel");
  });

  it("pede permissão para baixar, com Baixar em foco", () => {
    useSubject.setState({ phase: { kind: "ask" } });
    render(<SubjectHost />);
    const dialog = screen.getByRole("alertdialog", { name: "Baixar o modelo de recorte?" });
    expect(dialog.textContent).toContain("Nenhuma imagem sai do computador");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Baixar" }));
    act(() => useSubject.setState({ phase: { kind: "idle" } }));
    expect(screen.queryByTestId("subject-ask")).toBeNull();
  });
});
