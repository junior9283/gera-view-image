// Conta-gotas: o `EyeDropper` do navegador não existe no WebKitGTK e o portal de captura
// serve para a tela inteira. Aqui o usuário clica na imagem e a cor vem do pixel exibido
// (cor de tela, ver `colors.ts`), pelo mesmo caminho da visualização.
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { OverlayProps } from "../lib/slots";
import { throttle } from "../lib/throttle";
import { create } from "zustand";
import { useDocs } from "../store/docs";
import { sampleScreenColor } from "./colors";

interface EyedropperState {
  /** Quem recebe a cor escolhida; `null` = conta-gotas desligado. */
  onPick: ((hex: string) => void) | null;
  /** Cor sob o ponteiro (em px de tela da camada), para a dica ao lado dele. */
  hover: { x: number; y: number; color: string } | null;
}

export const useEyedropper = create<EyedropperState>(() => ({ onPick: null, hover: null }));

/** Liga o conta-gotas: o próximo clique na imagem entrega a cor a `onPick` e desliga. */
export const startEyedropper = (onPick: (hex: string) => void) => useEyedropper.setState({ onPick, hover: null });
export const stopEyedropper = () => useEyedropper.setState({ onPick: null, hover: null });

let peekSeq = 0;
/** A amostra ao passar o mouse é limitada: cada uma é uma chamada ao núcleo. */
const peek = throttle((id: number, ix: number, iy: number, w: number, h: number, x: number, y: number) => {
  const n = ++peekSeq;
  void sampleScreenColor(id, ix, iy, w, h)
    .then((color) => n === peekSeq && useEyedropper.setState({ hover: color ? { x, y, color } : null }))
    .catch(() => {});
}, 80);

/** Camada sobre a imagem enquanto o conta-gotas está ligado (slot `viewport-overlay`). */
export function Eyedropper({ scale, panX, panY, imageW, imageH }: OverlayProps) {
  const { t } = useTranslation();
  const onPick = useEyedropper((s) => s.onPick);
  const id = useDocs((s) => s.activeId);
  const hover = useEyedropper((s) => s.hover);

  useEffect(() => {
    if (!onPick) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      stopEyedropper();
    };
    window.addEventListener("keydown", esc, true);
    return () => window.removeEventListener("keydown", esc, true);
  }, [onPick]);

  if (!onPick || id === null) return null;

  const at = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const [sx, sy] = [e.clientX - r.left, e.clientY - r.top];
    return { sx, sy, ix: (sx - panX) / scale, iy: (sy - panY) / scale };
  };
  const inside = (ix: number, iy: number) => ix >= 0 && iy >= 0 && ix < imageW && iy < imageH;

  return (
    <div
      className="eyedropper-layer"
      data-testid="eyedropper-layer"
      role="presentation"
      onPointerMove={(e) => {
        const { sx, sy, ix, iy } = at(e);
        if (inside(ix, iy)) peek(id, ix, iy, imageW, imageH, sx, sy);
        else useEyedropper.setState({ hover: null });
      }}
      onPointerLeave={() => useEyedropper.setState({ hover: null })}
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const { ix, iy } = at(e);
        if (!inside(ix, iy)) return;
        void sampleScreenColor(id, ix, iy, imageW, imageH)
          .then((hex) => {
            if (!hex) return;
            const cb = useEyedropper.getState().onPick;
            stopEyedropper();
            cb?.(hex);
          })
          .catch((err) => console.error("falha ao ler a cor:", err));
      }}
    >
      <div className="eyedropper-hint">{t("markup.colors.eyedropperHint")}</div>
      {hover && (
        <div className="eyedropper-swatch" style={{ left: hover.x + 14, top: hover.y + 14 }}>
          <span style={{ background: hover.color }} />
          {hover.color}
        </div>
      )}
    </div>
  );
}
