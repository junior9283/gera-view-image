import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastHost } from "./Toast";
import { dismissToast, getToasts, notifyError, resetToastsForTests } from "./notify";

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
    // Os dois caem na mesma mensagem genérica: um aviso só (deduplicado).
    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].textContent).toContain("Não foi possível concluir a ação");
  });

  it("no máximo 3 avisos; texto repetido não duplica e renova o prazo; timers são limpos", () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const code of ["io", "corrupt", "permission", "not_found"]) notifyError({ code });
    expect(getToasts().map((t) => t.text)).toEqual(["Arquivo danificado ou incompleto", "Sem permissão para acessar o arquivo", "Arquivo não encontrado"]);
    expect(vi.getTimerCount()).toBe(3);
    vi.advanceTimersByTime(4000);
    notifyError({ code: "not_found" });
    expect(getToasts()).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(3);
    vi.advanceTimersByTime(2000);
    expect(getToasts().map((t) => t.text)).toEqual(["Arquivo não encontrado"]);
    dismissToast(getToasts()[0].id);
    expect(vi.getTimerCount()).toBe(0);
    notifyError({ code: "io" });
    resetToastsForTests();
    expect(vi.getTimerCount()).toBe(0);
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
