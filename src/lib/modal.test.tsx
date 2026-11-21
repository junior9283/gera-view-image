import { useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useModal } from "./modal";

function Dialog({ onClose, children }: { onClose?: () => void; children?: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useModal(ref, { onClose });
  return (
    <div ref={ref} role="dialog" aria-modal="true">
      {children ?? (
        <>
          <button>um</button>
          <input aria-label="dois" />
          <button disabled>desabilitado</button>
          <button>três</button>
        </>
      )}
    </div>
  );
}

function Host({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>abrir</button>
      {open && (
        <Dialog
          onClose={() => {
            onClose?.();
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

afterEach(cleanup);

const tab = (shift = false) => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Tab", shiftKey: shift });

describe("useModal", () => {
  it("foca o primeiro controle e prende Tab e Shift+Tab dentro do diálogo", () => {
    render(<Dialog />);
    expect(document.activeElement).toBe(screen.getByText("um"));
    tab();
    expect(document.activeElement).toBe(screen.getByLabelText("dois"));
    tab();
    expect(document.activeElement).toBe(screen.getByText("três"));
    tab();
    expect(document.activeElement).toBe(screen.getByText("um"));
    tab(true);
    expect(document.activeElement).toBe(screen.getByText("três"));
  });

  it("Esc fecha mesmo com o foco fora do diálogo, sem chegar aos atalhos globais", () => {
    const onClose = vi.fn();
    const global = vi.fn();
    window.addEventListener("keydown", global);
    render(<Host onClose={onClose} />);
    fireEvent.click(screen.getByText("abrir"));
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document.body, { key: "Escape" });
    window.removeEventListener("keydown", global);
    expect(onClose).toHaveBeenCalledOnce();
    expect(global).not.toHaveBeenCalled();
  });

  it("devolve o foco ao elemento de origem ao fechar", () => {
    render(<Host />);
    const opener = screen.getByText("abrir");
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(screen.getByText("um"));
    act(() => void fireEvent.keyDown(document.activeElement!, { key: "Escape" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("sem controles, o foco fica no próprio diálogo", () => {
    render(<Dialog><p>só texto</p></Dialog>);
    const dlg = screen.getByRole("dialog");
    expect(document.activeElement).toBe(dlg);
    tab();
    expect(document.activeElement).toBe(dlg);
  });

  it("com dois abertos, só o de cima trata Esc", () => {
    const a = vi.fn();
    const b = vi.fn();
    render(
      <>
        <Dialog onClose={a} />
        <Dialog onClose={b} />
      </>,
    );
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(b).toHaveBeenCalledOnce();
    expect(a).not.toHaveBeenCalled();
  });
});
