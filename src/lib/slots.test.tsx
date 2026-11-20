import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { registerSlot, resetSlotsForTests, Slot } from "./slots";
import { canUndo, opsHistory, setHistoryProvider, undo } from "../edit/history";

afterEach(() => {
  resetSlotsForTests();
  setHistoryProvider(null);
});

describe("slots", () => {
  it("renderiza os registrados, na ordem, com as props do host, e remove ao desregistrar", () => {
    const A = ({ n }: { n: number }) => <span>a{n}</span>;
    const B = ({ n }: { n: number }) => <span>b{n}</span>;
    registerSlot("viewport-overlay", "a", A);
    const off = registerSlot("viewport-overlay", "b", B);
    const { container } = render(<Slot name="viewport-overlay" props={{ n: 1 }} />);
    expect(container.textContent).toBe("a1b1");
    act(() => off());
    expect(container.textContent).toBe("a1");
  });

  it("registrar de novo com a mesma chave substitui", () => {
    registerSlot("below-toolbar", "x", () => <span>velho</span>);
    registerSlot("below-toolbar", "x", () => <span>novo</span>);
    render(<Slot name="below-toolbar" props={{}} />);
    expect(screen.queryByText("velho")).toBeNull();
    expect(screen.getByText("novo")).toBeTruthy();
  });
});

describe("history", () => {
  it("delega ao provedor registrado e volta ao padrão com null", async () => {
    const p = { undo: vi.fn(async () => {}), redo: vi.fn(async () => {}), canUndo: () => true, canRedo: () => false };
    setHistoryProvider(p);
    await undo(1 as never);
    expect(p.undo).toHaveBeenCalledWith(1);
    expect(canUndo(1 as never)).toBe(true);
    setHistoryProvider(null);
    expect(canUndo(1 as never)).toBe(opsHistory.canUndo(1 as never));
  });
});
