import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastHost } from "./Toast";
import { notifyError, resetToastsForTests } from "./notify";

afterEach(() => {
  cleanup();
  resetToastsForTests();
  vi.useRealTimers();
});

describe("ToastHost / notifyError", () => {
  it("converte AppError {code} pela errorMessage", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<ToastHost />);
    act(() => notifyError({ code: "empty_selection", message: "x" }));
    expect(screen.getByRole("alert").textContent).toContain("Faça uma seleção primeiro");
  });

  it("erro sem código conhecido mostra a mensagem genérica", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<ToastHost />);
    act(() => notifyError(new Error("boom")));
    act(() => notifyError({ code: "inexistente" }));
    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(2);
    for (const a of alerts) expect(a.textContent).toContain("Não foi possível concluir a ação");
  });

  it("some sozinho e fecha pelo botão", () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<ToastHost />);
    act(() => notifyError({ code: "io" }));
    fireEvent.click(screen.getByRole("button", { name: "Fechar aviso" }));
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => notifyError({ code: "io" }));
    act(() => vi.advanceTimersByTime(6000));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
