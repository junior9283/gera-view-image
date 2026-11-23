import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import * as ipc from "../ipc/commands";
import type { Mask, Rect, SourceFormat } from "../ipc/types";
import { throttle } from "../lib/throttle";
import { annotationsFocused } from "../markup/store";
import { ARROWS, isTyping } from "../shortcuts/keymap";
import { dpr } from "../viewer/paint";
import { useDocs } from "../store/docs";
import { usePrefs } from "../store/prefs";
import { useSelection } from "../store/selection";
import { useUi } from "../store/ui";
import { sampleBitmap, simplifyPath, type Point } from "./lasso";
import { boundsOf, combineMasks, maskContains, modeFor, moveMask, type SelectMode } from "./mask";
import {
  FORMATS_WITHOUT_ALPHA,
  HANDLES,
  type Handle,
  type SelectionTool,
  handlePosition,
  hitHandle,
  latestOnly,
  rectFromPoints,
  resizeRect,
  toImage,
  toleranceFromDistance,
  toScreen,
  type ViewTransform,
} from "./tools";

const ALPHA_THROTTLE_MS = 60;
const ALPHA_FILL = [255, 0, 255, 110] as const; // magenta translúcido
const ANTS_MS = 100;
/** Arrasto menor que isto (px de tela) é um clique: não cria nem move a seleção. */
const DRAG_PX = 3;
/** Controles sobre a imagem: clicar neles não começa uma seleção. */
const CONTROLS = "button, input, textarea, select, a, [role=dialog], .eyedropper-layer";
/** `((x + y + fase) >> 2) & 1` repete a cada 8 fases. */
const ANTS_PHASES = 8;

interface Props extends ViewTransform {
  docId: number;
  format?: SourceFormat;
  /** Página mostrada (documento de várias páginas). */
  frame?: number;
  imageWidth: number;
  imageHeight: number;
}

type BoxShape = "rect" | "ellipse";
type Drag =
  | (Compose & { kind: "create"; start: Point; from: Point; moved: boolean; shape: BoxShape })
  | { kind: "resize"; handle: Handle; orig: Rect; start: Point; shape: BoxShape }
  | { kind: "move"; orig: Mask; bounds: Rect; start: Point; from: Point; moved: boolean }
  | (Compose & { kind: "lasso"; points: Point[]; snap: boolean })
  | AlphaDrag;

/** O que fazer com a seleção que já havia (`base`) ao soltar. */
interface Compose {
  mode: SelectMode;
  base: Mask | null;
}

/** Seleção em andamento; `over`: a de antes continua na tela (somar e subtrair). */
interface Draft {
  mask: Mask;
  over?: boolean;
}

interface AlphaDrag extends Compose {
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

const isWhole = (r: Rect, w: number, h: number) => r.w >= w && r.h >= h;

/** Etiqueta L×A ao lado do canto inferior direito da seleção, sem sair da área visível. */
function sizeLabelStyle(r: Rect, view: ViewTransform, area: { w: number; h: number }): CSSProperties {
  const [x, y] = toScreen(view, r.x + r.w, r.y + r.h);
  return {
    position: "absolute",
    left: Math.max(0, Math.min(x + 8, area.w - 96)),
    top: Math.max(0, Math.min(y + 8, area.h - 24)),
    padding: "2px 6px",
    borderRadius: 4,
    background: "rgba(0,0,0,0.75)",
    color: "#fff",
    font: "11px/1.4 Inter, system-ui, sans-serif",
    whiteSpace: "nowrap",
    pointerEvents: "none",
  };
}

/**
 * Camada de seleção: formigas marchando, alças, laço, laço magnético e Alfa Instantâneo.
 * Autocontida: sobreponha à área da imagem do Viewport (pai com `position: relative`).
 *
 * Sem ferramenta, arrastar na imagem seleciona um retângulo (ou a move, em Preferências): aí a
 * camada não fica na frente do ponteiro e ouve o que sobra no `.viewport`, depois do Texto ao Vivo,
 * da Marcação e dos botões. Teclas: com uma seleção, Shift soma e Alt subtrai (laço, formas e Alfa);
 * sem seleção prévia, Shift força quadrado/círculo. Arrastar dentro da seleção a move.
 */
export function SelectionLayer({ docId, format, frame, imageWidth: iw, imageHeight: ih, scale, panX, panY }: Props) {
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
  const dragPans = usePrefs((p) => p.dragPans);
  const slideshow = useUi((s) => s.slideshow);
  const [draft, setDraftState] = useState<Draft | null>(null);
  /** A prévia mais recente: o `pointerup` pode chegar antes de o React desenhar o último movimento. */
  const latest = useRef<Draft | null>(null);
  const setDraft = useCallback((d: Draft | null) => {
    latest.current = d;
    setDraftState(d);
  }, []);
  const [alpha, setAlpha] = useState<Mask | null>(null);

  /** Limpa a prévia e invalida respostas ainda em voo (elas comparam com `alphaSeq`). */
  const clearAlpha = useCallback(() => {
    alphaSeq.current++;
    setAlpha(null);
  }, []);

  const view = useMemo<ViewTransform>(() => ({ scale, panX, panY }), [scale, panX, panY]);
  /** Ferramenta em efeito: a escolhida ou, sem nenhuma, o retângulo do arraste. */
  const active: SelectionTool | null = tool ?? (dragPans || slideshow ? null : "rect");
  /** Máscaras na tela, a de cima por último. */
  const shown = useMemo(
    () => [...(selection && (!draft || draft.over) ? [selection] : []), ...(draft ? [draft.mask] : [])],
    [selection, draft],
  );

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

  // Contorno de seleções Bitmap: células de borda da grade amostrada, pré-renderizadas em canvases
  // offscreen (um por fase das formigas, criados sob demanda); cada quadro é só um `drawImage`.
  const bitmapEdges = useMemo(() => {
    const bitmap = shown.find((m) => m.type === "bitmap");
    if (!bitmap || typeof document === "undefined") return null;
    const { cells, tw, th, step } = sampleBitmap(bitmap);
    const at = (x: number, y: number) => (x < 0 || y < 0 || x >= tw || y >= th ? 0 : cells[y * tw + x]);
    const edges: [number, number][] = [];
    for (let y = 0; y < th; y++)
      for (let x = 0; x < tw; x++)
        if (at(x, y) && !(at(x - 1, y) && at(x + 1, y) && at(x, y - 1) && at(x, y + 1))) edges.push([x, y]);
    const frames: (HTMLCanvasElement | null)[] = Array(ANTS_PHASES).fill(null);
    const frame = (phase: number): HTMLCanvasElement | null => {
      const p = phase % ANTS_PHASES;
      if (frames[p]) return frames[p];
      const cv = document.createElement("canvas");
      cv.width = tw;
      cv.height = th;
      const ctx = cv.getContext("2d");
      if (!ctx) return null;
      const img = ctx.createImageData(tw, th);
      for (const [x, y] of edges) img.data.set(((x + y + p) >> 2) & 1 ? [0, 0, 0, 255] : [255, 255, 255, 255], (y * tw + x) * 4);
      ctx.putImageData(img, 0, 0);
      return (frames[p] = cv);
    };
    return { frame, tw, th, step };
  }, [shown]);

  useEffect(() => {
    let phase = 0;
    const draw = () => {
      const cv = canvasRef.current;
      const ctx = cv?.getContext("2d");
      if (!cv || !ctx) return;
      const k = dpr();
      ctx.setTransform(k, 0, 0, k, 0, 0);
      ctx.clearRect(0, 0, size.w, size.h);
      if (alphaSprite) {
        const [x, y] = toScreen(view, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(alphaSprite.cv, x, y, alphaSprite.cv.width * alphaSprite.step * scale, alphaSprite.cv.height * alphaSprite.step * scale);
      }
      for (const m of shown) drawAnts(ctx, m);
      const top = shown[shown.length - 1] ?? null;
      if ((active === "rect" || active === "ellipse") && isBox(top) && shown.length === 1) {
        for (const h of HANDLES) {
          const [x, y] = handlePosition(top.data, view, h);
          ctx.fillStyle = "#fff";
          ctx.strokeStyle = "#000";
          ctx.fillRect(x - 3.5, y - 3.5, 7, 7);
          ctx.strokeRect(x - 3.5, y - 3.5, 7, 7);
        }
      }
    };
    const drawAnts = (ctx: CanvasRenderingContext2D, m: Mask) => {
      if (m.type === "bitmap") {
        const edges = bitmapEdges?.frame(phase);
        if (!bitmapEdges || !edges) return;
        const cell = bitmapEdges.step * scale;
        const [x, y] = toScreen(view, 0, 0);
        // Células menores que 1 px: com suavização o contorno some menos do que com vizinho mais próximo.
        ctx.imageSmoothingEnabled = cell < 1;
        ctx.drawImage(edges, x, y, bitmapEdges.tw * cell, bitmapEdges.th * cell);
        return;
      }
      const trace = () => {
        ctx.beginPath();
        if (m.type === "rect") {
          const [x, y] = toScreen(view, m.data.x, m.data.y);
          ctx.rect(x, y, m.data.w * scale, m.data.h * scale);
        } else if (m.type === "ellipse") {
          const r = m.data;
          const [cx, cy] = toScreen(view, r.x + r.w / 2, r.y + r.h / 2);
          ctx.ellipse(cx, cy, (r.w / 2) * scale, (r.h / 2) * scale, 0, 0, Math.PI * 2);
        } else {
          m.data.forEach(([px, py], i) => {
            const [x, y] = toScreen(view, px, py);
            if (i) ctx.lineTo(x, y);
            else ctx.moveTo(x, y);
          });
          if (drag.current?.kind !== "lasso") ctx.closePath();
        }
      };
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
    };
    draw();
    if (!shown.length) return;
    // Aba/janela oculta: as formigas pausam (sem redesenho nem avanço de fase) e retomam ao voltar.
    const timer = setInterval(() => {
      if (document.hidden) return;
      phase += 1;
      draw();
    }, ANTS_MS);
    const onVisible = () => !document.hidden && draw();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [shown, size, view, scale, active, alphaSprite, bitmapEdges]);

  // Alfa Instantâneo pendente: Enter/Delete aplica, Escape descarta. Ouve na captura e consome a
  // tecla, para o keymap global (Delete = Apagar, Esc = Desmarcar) não agir em dobro.
  useEffect(() => {
    if (!alpha) return;
    const onKey = (e: KeyboardEvent) => {
      // Digitar num campo de texto não pode aplicar nem descartar o Alfa Instantâneo.
      if ((e.target as Element | null)?.closest?.("input, textarea, [contenteditable]:not([contenteditable=false])")) return;
      if (e.key === "Escape") {
        e.preventDefault();
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
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [alpha, applyOp, docId, setSelection, clearAlpha]);

  // Setas movem a seleção (1 px; Shift, 10). No `document`: depois da barra lateral e dos menus, antes
  // da navegação entre imagens (useShortcuts, na window). Anotação selecionada tem prioridade.
  useEffect(() => {
    if (!selection) return;
    const onKey = (e: KeyboardEvent) => {
      const step = ARROWS[e.key];
      if (!step || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || isTyping(e.target)) return;
      if (useUi.getState().slideshow || document.querySelector('[aria-modal="true"]') || annotationsFocused(docId)) return;
      const bounds = boundsOf(selection, iw, ih);
      // A imagem inteira (Selecionar Tudo) não tem para onde ir: as setas continuam navegando.
      if (!bounds || isWhole(bounds, iw, ih)) return;
      e.preventDefault();
      const k = e.shiftKey ? 10 : 1;
      const moved = moveMask(selection, step[0] * k, step[1] * k, iw, ih, bounds);
      setSelection(moved);
      if (alpha) setAlpha(moved);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selection, alpha, docId, iw, ih, setSelection]);

  const local = (e: PointerEvent): Point => {
    const r = canvasRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const clampPx = ([x, y]: Point): Point => [
    Math.min(iw - 1, Math.max(0, Math.floor(x))),
    Math.min(ih - 1, Math.max(0, Math.floor(y))),
  ];
  const compose = ({ mode, base }: Compose, m: Mask): Mask | null =>
    mode === "replace" || !base ? m : combineMasks(base, m, mode, iw, ih);

  const onDown = (e: PointerEvent, el: Element) => {
    if (!active || e.button !== 0) return;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* ponteiro já liberado (ou ambiente sem captura) */
    }
    const from = local(e);
    const p = toImage(view, ...from);
    clearAlpha();
    const how: Compose = { mode: modeFor(selection, e), base: selection };
    // Com Shift/Alt o arraste compõe, mesmo começando numa alça (subtrair um canto, por exemplo).
    if (how.mode === "replace" && (active === "rect" || active === "ellipse") && isBox(selection)) {
      const handle = hitHandle(selection.data, view, ...from);
      if (handle) return void (drag.current = { kind: "resize", handle, orig: selection.data, start: p, shape: selection.type });
    }
    // O Alfa Instantâneo sempre escolhe outra cor, mesmo dentro da seleção.
    if (how.mode === "replace" && selection && active !== "instantAlpha" && maskContains(selection, ...p)) {
      const bounds = boundsOf(selection, iw, ih);
      if (bounds && !isWhole(bounds, iw, ih)) return void (drag.current = { kind: "move", orig: selection, bounds, start: p, from, moved: false });
    }
    if (active === "rect" || active === "ellipse") {
      drag.current = { kind: "create", start: p, from, moved: false, shape: active, ...how };
    } else if (active === "lasso" || active === "smartLasso") {
      drag.current = { kind: "lasso", points: [p], snap: active === "smartLasso", ...how };
    } else {
      const seed = clampPx(p);
      const gen = ++alphaSeq.current;
      // Uma chamada por vez ao Rust; tolerâncias novas se reduzem à última.
      const request = latestOnly(
        (tol: number) => ipc.instantAlpha(docId, seed[0], seed[1], tol, frame),
        (m, _tol, last) => {
          if (gen !== alphaSeq.current) return; // arrasto cancelado ou substituído
          if (!d.released || !last) return setAlpha(m);
          const result = compose(how, m);
          setAlpha(result);
          setSelection(result);
        },
      );
      const d: AlphaDrag = { kind: "alpha", origin: from, request, fire: throttle(request, ALPHA_THROTTLE_MS), released: false, ...how };
      drag.current = d;
      d.fire(0);
    }
  };

  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const at = local(e);
    const p = toImage(view, ...at);
    if (d.kind === "create" || d.kind === "move") {
      d.moved ||= Math.hypot(at[0] - d.from[0], at[1] - d.from[1]) >= DRAG_PX;
      if (!d.moved) return;
      if (d.kind === "move") return setDraft({ mask: moveMask(d.orig, p[0] - d.start[0], p[1] - d.start[1], iw, ih, d.bounds) });
      const over = d.mode !== "replace";
      setDraft({ mask: { type: d.shape, data: rectFromPoints(d.start, p, iw, ih, e.shiftKey && !over) }, over });
    } else if (d.kind === "resize") {
      const data = resizeRect(d.orig, d.handle, Math.round(p[0] - d.start[0]), Math.round(p[1] - d.start[1]), iw, ih);
      setDraft({ mask: { type: d.shape, data } });
    } else if (d.kind === "lasso") {
      const last = d.points[d.points.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) * scale >= 2) {
        d.points.push(p);
        setDraft({ mask: { type: "polygon", data: d.points.slice() }, over: d.mode !== "replace" });
      }
    } else if (d.kind === "alpha") {
      d.fire(toleranceFromDistance(Math.hypot(at[0] - d.origin[0], at[1] - d.origin[1])));
    }
  };

  const onUp = (e: PointerEvent) => {
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
    const committed = latest.current?.mask ?? null;
    setDraft(null);
    if (d.kind === "lasso") {
      const pts = simplifyPath(d.points, 1 / scale);
      if (pts.length < 3) return d.mode === "replace" ? setSelection(null) : undefined;
      if (!d.snap) return setSelection(compose(d, { type: "polygon", data: pts }));
      void ipc.snapLasso(docId, pts, frame).then((snapped) => {
        if (snapped.length >= 3) setSelection(compose(d, { type: "polygon", data: snapped }));
      });
    } else if (d.kind !== "create") {
      if (committed) setSelection(committed);
    } else if (isBox(committed) && committed.data.w > 0 && committed.data.h > 0) {
      setSelection(compose(d, committed));
    } else if (d.mode === "replace") {
      setSelection(null); // clique fora da seleção
    }
  };

  /** Cancelar o ponteiro descarta o arrasto (não confirma a seleção). */
  const onCancel = () => {
    const d = drag.current;
    drag.current = null;
    setDraft(null);
    if (d?.kind === "alpha") {
      d.fire.cancel();
      clearAlpha();
    }
  };

  // Arraste sem ferramenta: ouvintes nativos no Viewport (registrados uma vez), que recebem só o que
  // as outras camadas não consumiram. Com uma ferramenta escolhida, quem recebe é o canvas.
  const handlers = useRef({ onDown, onMove, onUp, onCancel, implicit: false });
  useLayoutEffect(() => {
    handlers.current = { onDown, onMove, onUp, onCancel, implicit: !tool && active !== null };
  });
  useEffect(() => {
    const el = wrapRef.current?.closest<HTMLElement>(".viewport");
    if (!el) return;
    let dragging = false;
    const down = (e: PointerEvent) => {
      const { implicit, onDown } = handlers.current;
      // Espaço armado: o arraste é do Viewport (mover a imagem).
      if (!implicit || el.classList.contains("space-pan") || (e.target as Element).closest(CONTROLS)) return;
      onDown(e, el);
      dragging = drag.current !== null;
    };
    const move = (e: PointerEvent) => dragging && handlers.current.onMove(e);
    const end = (f: "onUp" | "onCancel") => (e: PointerEvent) => {
      if (dragging) handlers.current[f](e);
      dragging = false;
    };
    const listeners: [string, (e: PointerEvent) => void][] = [
      ["pointerdown", down], ["pointermove", move], ["pointerup", end("onUp")], ["pointercancel", end("onCancel")],
    ];
    for (const [n, f] of listeners) el.addEventListener(n, f as EventListener);
    return () => {
      for (const [n, f] of listeners) el.removeEventListener(n, f as EventListener);
    };
  }, []);

  const noAlpha = alpha && format && FORMATS_WITHOUT_ALPHA.has(format);

  return (
    <div ref={wrapRef} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      <canvas
        ref={canvasRef}
        aria-label={t("select.layer")}
        width={Math.round(size.w * dpr())}
        height={Math.round(size.h * dpr())}
        style={{ width: size.w, height: size.h, pointerEvents: tool ? "auto" : "none", cursor: tool ? "crosshair" : "default", touchAction: "none" }}
        onPointerDown={(e) => onDown(e.nativeEvent, e.currentTarget)}
        onPointerMove={(e) => onMove(e.nativeEvent)}
        onPointerUp={(e) => onUp(e.nativeEvent)}
        onPointerCancel={onCancel}
      />
      {draft && isBox(draft.mask) && (
        <div data-testid="selection-size" className="select-size" style={sizeLabelStyle(draft.mask.data, view, size)}>
          {t("select.size", { w: draft.mask.data.w, h: draft.mask.data.h })}
        </div>
      )}
      {alpha && (
        <div role="status" className="select-notice" style={{ position: "absolute", left: 12, bottom: 12, padding: "6px 10px", borderRadius: 6, background: "rgba(0,0,0,0.75)", color: "#fff", fontSize: 12 }}>
          {noAlpha ? t("select.noAlphaNotice") : t("select.instantAlphaHint")}
        </div>
      )}
    </div>
  );
}
