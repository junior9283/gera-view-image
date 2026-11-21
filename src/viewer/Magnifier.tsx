// Ferramentas › Mostrar Lupa (Lote 8, tecla `): lente redonda que segue o ponteiro e amplia a imagem
// sob ele, como a do Pré-Visualização. Pede ao núcleo só a região sob a lente, na resolução que a
// ampliação pede (não reaproveita o buffer do Viewport, que vem reduzido no "ajustar").
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { renderView } from "../ipc/commands";
import type { Rect } from "../ipc/types";
import type { OverlayProps } from "../lib/slots";
import { useDocs } from "../store/docs";
import { usePrefs } from "../store/prefs";
import { useUi } from "../store/ui";
import { bufferToCanvas, checkerPattern, dpr } from "./paint";

/** Diâmetro da lente, em px CSS. */
export const LENS_SIZE = 180;
/** Ampliação da lente sobre a escala atual da imagem. */
export const LENS_ZOOM = 3;

let on = false;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const magnifierOn = () => on;
export function toggleMagnifier(): void {
  on = !on;
  listeners.forEach((l) => l());
}

/** Só para testes. */
export function resetMagnifierForTests(): void {
  on = false;
  listeners.forEach((l) => l());
}

interface Buf {
  canvas: HTMLCanvasElement;
  key: string;
  region: Rect;
  density: number;
}

const contains = (a: Rect, b: Rect) => a.x <= b.x && a.y <= b.y && a.x + a.w >= b.x + b.w && a.y + a.h >= b.y + b.h;

/** Retângulo (px inteiros da imagem) centrado em (cx, cy) com meia-largura `half`, limitado à imagem. */
function around(cx: number, cy: number, half: number, w: number, h: number): Rect | null {
  const x = Math.max(0, Math.floor(cx - half));
  const y = Math.max(0, Math.floor(cy - half));
  const r = { x, y, w: Math.min(w, Math.ceil(cx + half)) - x, h: Math.min(h, Math.ceil(cy + half)) - y };
  return r.w > 0 && r.h > 0 ? r : null;
}

export function Magnifier({ scale, panX, panY, imageW, imageH }: OverlayProps) {
  const visible = useSyncExternalStore(subscribe, magnifierOn);
  const doc = useDocs((s) => s.docs.find((d) => d.id === s.activeId) ?? null);
  const frame = useUi((s) => s.page) ?? 0;
  const showBg = usePrefs((p) => p.showImageBackground);
  const layer = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const buffer = useRef<Buf | null>(null);
  const loading = useRef(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  /** Muda quando chega um buffer: redesenha e confere se ainda falta outro. */
  const [, setLoaded] = useState(0);

  // O overlay não recebe eventos de ponteiro (a seleção e a Marcação ficam com eles): ouve na janela.
  useEffect(() => {
    if (!visible) return;
    const onMove = (e: PointerEvent) => {
      const r = layer.current?.getBoundingClientRect();
      if (!r) return;
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      const { w, h } = useUi.getState().viewSize;
      setPos(x >= 0 && y >= 0 && x < w && y < h ? { x, y } : null);
    };
    const onLeave = () => setPos(null);
    window.addEventListener("pointermove", onMove);
    document.documentElement.addEventListener("pointerleave", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      setPos(null);
    };
  }, [visible]);

  const lensScale = scale * LENS_ZOOM;
  const center = pos && { x: (pos.x - panX) / scale, y: (pos.y - panY) / scale };
  const key = doc ? `${doc.id}:${doc.rev}:${frame}` : "";

  // Desenha a lente com o buffer que houver (mesmo de menor resolução) e pede o que faltar.
  useLayoutEffect(() => {
    const cv = canvas.current;
    if (!cv || !center || !doc) return;
    const k = dpr();
    const size = Math.round(LENS_SIZE * k);
    if (cv.width !== size) cv.width = cv.height = size;
    const ctx = cv.getContext("2d");
    if (ctx) {
      const f = lensScale * k;
      const ox = size / 2 - center.x * f;
      const oy = size / 2 - center.y * f;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, size, size);
      if (showBg) {
        ctx.fillStyle = checkerPattern(ctx, Math.round(8 * k)) ?? "#fff";
        ctx.fillRect(ox, oy, imageW * f, imageH * f);
      }
      const b = buffer.current;
      if (b?.key === key) {
        const w = b.region.w * f;
        ctx.imageSmoothingEnabled = w / b.canvas.width < 2;
        ctx.drawImage(b.canvas, ox + b.region.x * f, oy + b.region.y * f, w, b.region.h * f);
      }
    }

    const half = LENS_SIZE / 2 / lensScale;
    const need = around(center.x, center.y, half, imageW, imageH);
    // O núcleo nunca amplia: acima de 1 px de tela por px da imagem, vem a resolução nativa.
    const density = Math.min(1, lensScale * k);
    const b = buffer.current;
    if (!need || loading.current || (b?.key === key && contains(b.region, need) && b.density >= density * 0.98)) return;
    // Margem de uma lente para cada lado: o ponteiro anda sem pedir de novo a cada pixel.
    const region = around(center.x, center.y, half * 2, imageW, imageH)!;
    loading.current = true;
    renderView(doc.id, frame, Math.max(1, Math.ceil(region.w * density)), Math.max(1, Math.ceil(region.h * density)), region)
      .then((v) => (buffer.current = { canvas: bufferToCanvas(v), key, region, density }))
      .catch((e) => console.error("falha ao desenhar a lupa:", e))
      .finally(() => {
        loading.current = false;
        setLoaded((n) => n + 1);
      });
  });

  if (!visible) return null;
  return (
    <div ref={layer} style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      {pos && (
        <canvas
          ref={canvas}
          data-testid="magnifier"
          aria-hidden="true"
          style={{
            position: "absolute",
            left: `${pos.x - LENS_SIZE / 2}px`,
            top: `${pos.y - LENS_SIZE / 2}px`,
            width: LENS_SIZE,
            height: LENS_SIZE,
            borderRadius: "50%",
            background: "var(--chrome-bg)",
            boxShadow: "0 0 0 3px rgba(255, 255, 255, 0.9), 0 2px 12px rgba(0, 0, 0, 0.5)",
            pointerEvents: "none",
          }}
        />
      )}
    </div>
  );
}
