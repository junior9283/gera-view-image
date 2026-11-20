import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import * as ipc from "../ipc/commands";
import type { Mask, Rect, SourceFormat } from "../ipc/types";
import { useDocs } from "../store/docs";
import { useSelection } from "../store/selection";
import { sampleBitmap, simplifyPath, type Point } from "./lasso";
import {
  FORMATS_WITHOUT_ALPHA,
  HANDLES,
  type Handle,
  handlePosition,
  hitHandle,
  latestOnly,
  rectFromPoints,
  resizeRect,
  throttle,
  toImage,
  toleranceFromDistance,
  toScreen,
  type ViewTransform,
} from "./tools";

const ALPHA_THROTTLE_MS = 60;
const ALPHA_FILL = [255, 0, 255, 110] as const; // magenta translúcido
const ANTS_MS = 100;

interface Props extends ViewTransform {
  docId: number;
  format?: SourceFormat;
  imageWidth: number;
  imageHeight: number;
}

type Drag =
  | { kind: "create"; start: [number, number] }
  | { kind: "resize"; handle: Handle; orig: Rect; start: [number, number]; shape: "rect" | "ellipse" }
  | { kind: "move"; orig: Rect; start: [number, number]; shape: "rect" | "ellipse" }
  | { kind: "lasso"; points: Point[]; snap: boolean }
  | AlphaDrag;

interface AlphaDrag {
  kind: "alpha";
  /** Ponto de tela do início do arrasto (a distância dele dá a tolerância). */
  origin: [number, number];
  /** Pedido com throttle (durante o arrasto) e pedido direto (ao soltar). */
  fire: ReturnType<typeof throttle<[number]>>;
  request: (tolerance: number) => void;
  released: boolean;
}

const isBox = (m: Mask | null): m is Extract<Mask, { type: "rect" | "ellipse" }> =>
  m?.type === "rect" || m?.type === "ellipse";

/** Camada de seleção: formigas marchando, alças, laço, laço magnético e Alfa Instantâneo.
 *  Autocontida: sobreponha à área da imagem do Viewport (pai com `position: relative`). */
export function SelectionLayer({ docId, format, imageWidth: iw, imageHeight: ih, scale, panX, panY }: Props) {
  const { t } = useTranslation();
  const selection = useSelection((s) => s.selection);
  const tool = useSelection((s) => s.selectionTool);
  const setSelection = useSelection((s) => s.setSelection);
  const applyOp = useDocs((s) => s.applyOp);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<Drag | null>(null);
  const alphaSeq = useRef(0);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [draft, setDraft] = useState<Mask | null>(null);
  const [alpha, setAlpha] = useState<Mask | null>(null);

  /** Limpa a prévia e invalida respostas ainda em voo (elas comparam com `alphaSeq`). */
  const clearAlpha = useCallback(() => {
    alphaSeq.current++;
    setAlpha(null);
  }, []);

  const view = useMemo<ViewTransform>(() => ({ scale, panX, panY }), [scale, panX, panY]);
  const shown = draft ?? selection;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Prévia magenta do Alfa Instantâneo, numa grade grosseira (nunca w*h inteiro).
  const alphaSprite = useMemo(() => {
    if (alpha?.type !== "bitmap" || typeof document === "undefined") return null;
    const { cells, tw, th, step } = sampleBitmap(alpha);
    const cv = document.createElement("canvas");
    cv.width = tw;
    cv.height = th;
    const ctx = cv.getContext("2d");
    if (!ctx) return null;
    const img = ctx.createImageData(tw, th);
    cells.forEach((c, i) => c && img.data.set(ALPHA_FILL, i * 4));
    ctx.putImageData(img, 0, 0);
    return { cv, step };
  }, [alpha]);

  // Contorno de seleções Bitmap: células de borda da grade amostrada.
  const bitmapEdges = useMemo(() => {
    if (shown?.type !== "bitmap") return null;
    const { cells, tw, th, step } = sampleBitmap(shown);
    const at = (x: number, y: number) => (x < 0 || y < 0 || x >= tw || y >= th ? 0 : cells[y * tw + x]);
    const edges: [number, number][] = [];
    for (let y = 0; y < th; y++)
      for (let x = 0; x < tw; x++)
        if (at(x, y) && !(at(x - 1, y) && at(x + 1, y) && at(x, y - 1) && at(x, y + 1))) edges.push([x, y]);
    return { edges, step };
  }, [shown]);

  useEffect(() => {
    let phase = 0;
    const draw = () => {
      const cv = canvasRef.current;
      const ctx = cv?.getContext("2d");
      if (!cv || !ctx) return;
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size.w, size.h);
      if (alphaSprite) {
        const [x, y] = toScreen(view, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(alphaSprite.cv, x, y, alphaSprite.cv.width * alphaSprite.step * scale, alphaSprite.cv.height * alphaSprite.step * scale);
      }
      if (!shown) return;
      const trace = () => {
        ctx.beginPath();
        if (shown.type === "rect") {
          const r = shown.data;
          const [x, y] = toScreen(view, r.x, r.y);
          ctx.rect(x, y, r.w * scale, r.h * scale);
        } else if (shown.type === "ellipse") {
          const r = shown.data;
          const [cx, cy] = toScreen(view, r.x + r.w / 2, r.y + r.h / 2);
          ctx.ellipse(cx, cy, (r.w / 2) * scale, (r.h / 2) * scale, 0, 0, Math.PI * 2);
        } else if (shown.type === "polygon") {
          shown.data.forEach(([px, py], i) => {
            const [x, y] = toScreen(view, px, py);
            if (i) ctx.lineTo(x, y);
            else ctx.moveTo(x, y);
          });
          if (!drag.current || drag.current.kind !== "lasso") ctx.closePath();
        }
      };
      if (shown.type === "bitmap") {
        if (bitmapEdges) {
          const px = Math.max(1, bitmapEdges.step * scale);
          for (const [tx, ty] of bitmapEdges.edges) {
            const [x, y] = toScreen(view, tx * bitmapEdges.step, ty * bitmapEdges.step);
            ctx.fillStyle = ((tx + ty + phase) >> 2) & 1 ? "#000" : "#fff";
            ctx.fillRect(x, y, px, px);
          }
        }
      } else {
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        ctx.strokeStyle = "#fff";
        trace();
        ctx.stroke();
        ctx.setLineDash([4, 4]);
        ctx.lineDashOffset = -phase;
        ctx.strokeStyle = "#000";
        trace();
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if ((tool === "rect" || tool === "ellipse") && isBox(shown)) {
        for (const h of HANDLES) {
          const [x, y] = handlePosition(shown.data, view, h);
          ctx.fillStyle = "#fff";
          ctx.strokeStyle = "#000";
          ctx.fillRect(x - 3.5, y - 3.5, 7, 7);
          ctx.strokeRect(x - 3.5, y - 3.5, 7, 7);
        }
      }
    };
    draw();
    if (!shown) return;
    const timer = setInterval(() => {
      phase += 1;
      draw();
    }, ANTS_MS);
    return () => clearInterval(timer);
  }, [shown, size, view, scale, tool, alphaSprite, bitmapEdges]);

  // Alfa Instantâneo pendente: Enter/Delete aplica, Escape descarta.
  useEffect(() => {
    if (!alpha) return;
    const onKey = (e: KeyboardEvent) => {
      // Digitar num campo de texto não pode aplicar nem descartar o Alfa Instantâneo.
      if ((e.target as Element | null)?.closest?.("input, textarea, [contenteditable]:not([contenteditable=false])")) return;
      if (e.key === "Escape") {
        clearAlpha();
        setSelection(null);
      } else if (e.key === "Enter" || e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        void applyOp(docId, { type: "makeTransparent", data: alpha }).then(() => {
          clearAlpha();
          setSelection(null);
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [alpha, applyOp, docId, setSelection, clearAlpha]);

  const local = (e: ReactPointerEvent): [number, number] => {
    const r = canvasRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const clampPx = ([x, y]: [number, number]): [number, number] => [
    Math.min(iw - 1, Math.max(0, Math.floor(x))),
    Math.min(ih - 1, Math.max(0, Math.floor(y))),
  ];

  const onPointerDown = (e: ReactPointerEvent) => {
    if (!tool || e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const [sx, sy] = local(e);
    const p = toImage(view, sx, sy);
    clearAlpha();
    if (tool === "rect" || tool === "ellipse") {
      if (isBox(selection)) {
        const handle = hitHandle(selection.data, view, sx, sy);
        const shape = selection.type;
        if (handle) return void (drag.current = { kind: "resize", handle, orig: selection.data, start: p, shape });
        const r = selection.data;
        if (p[0] >= r.x && p[0] < r.x + r.w && p[1] >= r.y && p[1] < r.y + r.h)
          return void (drag.current = { kind: "move", orig: r, start: p, shape });
      }
      drag.current = { kind: "create", start: p };
    } else if (tool === "lasso" || tool === "smartLasso") {
      drag.current = { kind: "lasso", points: [p], snap: tool === "smartLasso" };
    } else {
      const seed = clampPx(p);
      const gen = ++alphaSeq.current;
      // Uma chamada por vez ao Rust; tolerâncias novas se reduzem à última.
      const request = latestOnly(
        (tol: number) => ipc.instantAlpha(docId, seed[0], seed[1], tol),
        (m, _tol, last) => {
          if (gen !== alphaSeq.current) return; // arrasto cancelado ou substituído
          setAlpha(m);
          if (d.released && last) setSelection(m);
        },
      );
      const d: AlphaDrag = { kind: "alpha", origin: [sx, sy], request, fire: throttle(request, ALPHA_THROTTLE_MS), released: false };
      drag.current = d;
      d.fire(0);
    }
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const [sx, sy] = local(e);
    const p = toImage(view, sx, sy);
    if (d.kind === "create" && (tool === "rect" || tool === "ellipse")) {
      setDraft({ type: tool, data: rectFromPoints(d.start, p, iw, ih, e.shiftKey) });
    } else if (d.kind === "resize") {
      const data = resizeRect(d.orig, d.handle, Math.round(p[0] - d.start[0]), Math.round(p[1] - d.start[1]), iw, ih);
      setDraft({ type: d.shape, data });
    } else if (d.kind === "move") {
      const x = Math.min(iw - d.orig.w, Math.max(0, Math.round(d.orig.x + p[0] - d.start[0])));
      const y = Math.min(ih - d.orig.h, Math.max(0, Math.round(d.orig.y + p[1] - d.start[1])));
      setDraft({ type: d.shape, data: { ...d.orig, x, y } });
    } else if (d.kind === "lasso") {
      const last = d.points[d.points.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) * scale >= 2) {
        d.points.push(p);
        setDraft({ type: "polygon", data: d.points.slice() });
      }
    } else if (d.kind === "alpha") {
      d.fire(toleranceFromDistance(Math.hypot(sx - d.origin[0], sy - d.origin[1])));
    }
  };

  const onPointerUp = (e: ReactPointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind === "alpha") {
      const [sx, sy] = local(e);
      d.fire.cancel();
      d.released = true; // o resultado mais recente vira a seleção
      d.request(toleranceFromDistance(Math.hypot(sx - d.origin[0], sy - d.origin[1])));
      return;
    }
    const committed = draft;
    setDraft(null);
    if (d.kind === "lasso") {
      const pts = simplifyPath(d.points, 1 / scale);
      if (pts.length < 3) return setSelection(null);
      if (!d.snap) return setSelection({ type: "polygon", data: pts });
      void ipc.snapLasso(docId, pts).then((snapped) => {
        if (snapped.length >= 3) setSelection({ type: "polygon", data: snapped });
      });
    } else if (committed && isBox(committed) && committed.data.w > 0 && committed.data.h > 0) {
      setSelection(committed);
    } else if (d.kind === "create") {
      setSelection(null);
    }
  };

  /** Cancelar o ponteiro descarta o arrasto (não confirma a seleção). */
  const onPointerCancel = () => {
    const d = drag.current;
    drag.current = null;
    setDraft(null);
    if (d?.kind === "alpha") {
      d.fire.cancel();
      clearAlpha();
    }
  };

  const noAlpha = alpha && format && FORMATS_WITHOUT_ALPHA.has(format);

  return (
    <div ref={wrapRef} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      <canvas
        ref={canvasRef}
        aria-label={t("select.layer")}
        width={Math.round(size.w * (window.devicePixelRatio || 1))}
        height={Math.round(size.h * (window.devicePixelRatio || 1))}
        style={{ width: size.w, height: size.h, pointerEvents: tool ? "auto" : "none", cursor: tool ? "crosshair" : "default", touchAction: "none" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      />
      {alpha && (
        <div role="status" className="select-notice" style={{ position: "absolute", left: 12, bottom: 12, padding: "6px 10px", borderRadius: 6, background: "rgba(0,0,0,0.75)", color: "#fff", fontSize: 12 }}>
          {noAlpha ? t("select.noAlphaNotice") : t("select.instantAlphaHint")}
        </div>
      )}
    </div>
  );
}
