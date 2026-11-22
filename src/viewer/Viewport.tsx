import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { renderView } from "../ipc/commands";
import type { DocInfo, Rect } from "../ipc/types";
import { useDocs } from "../store/docs";
import { usePrefs, type Prefs } from "../store/prefs";
import { useUi } from "../store/ui";
import { panBy, syncView, toggleFitActual, zoomBy } from "./actions";
import { DocError } from "./DocError";
import { useImageAlt } from "./imageAlt";
import { bufferToCanvas, checkerPattern, dpr, useAnimatedFrame } from "./paint";
import { useZoomUnit } from "./unit";
import { visibleRegion, type Size, type ViewState } from "./zoom";
import { ByteLru } from "../lib/byteLru";
import { Slot, type OverlayProps } from "../lib/slots";
import { useSelection } from "../store/selection";
import { isTyping } from "../shortcuts/keymap";
import "./viewer.css";

/** Buffer já recebido do `render_view`: cobre `region` (px da imagem) de um documento/revisão/quadro. */
interface Buf {
  canvas: HTMLCanvasElement;
  id: number;
  rev: number;
  frame: number;
  region: Rect;
  img: Size;
  seq: number;
}

/** O que precisa ser pedido para a view atual. */
interface Need {
  rect: Rect;
  /** `null` = imagem inteira. */
  region: Rect | null;
  outW: number;
  outH: number;
  /** px do buffer por px da imagem. */
  density: number;
}

/** Orçamento de buffers guardados (quadros de GIF) para não estourar a memória. */
const CACHE_BYTES = 64 * 1024 * 1024;

const BACKGROUNDS: Record<Exclude<Prefs["background"], "custom">, string> = {
  window: "var(--chrome-bg)",
  black: "#000",
  white: "#fff",
  gray: "#808080",
};

/** Área visível com margem de 25 % (menos pedidos ao arrastar), na densidade que a tela usa. */
function needFor(view: ViewState, doc: DocInfo, size: Size): Need {
  const img = { w: doc.width, h: doc.height };
  const vis = visibleRegion(view, img, size);
  const mx = Math.ceil(vis.w / 4);
  const my = Math.ceil(vis.h / 4);
  const x = Math.max(0, vis.x - mx);
  const y = Math.max(0, vis.y - my);
  const rect = { x, y, w: Math.min(img.w, vis.x + vis.w + mx) - x, h: Math.min(img.h, vis.y + vis.h + my) - y };
  const full = rect.x === 0 && rect.y === 0 && rect.w === img.w && rect.h === img.h;
  // O Rust nunca amplia: acima de 1 px de tela por px da imagem, vem a resolução nativa.
  const density = Math.min(1, view.scale * dpr());
  return {
    rect,
    region: full ? null : rect,
    outW: Math.max(1, Math.ceil(rect.w * density)),
    outH: Math.max(1, Math.ceil(rect.h * density)),
    density,
  };
}

const contains = (a: Rect, b: Rect) => a.x <= b.x && a.y <= b.y && a.x + a.w >= b.x + b.w && a.y + a.h >= b.y + b.h;

const satisfies = (b: Buf, doc: DocInfo, frame: number, need: Need) =>
  b.id === doc.id &&
  b.rev === doc.rev &&
  b.frame === frame &&
  contains(b.region, need.rect) &&
  b.canvas.width / b.region.w >= need.density * 0.98;

/** `devicePixelRatio` atual, atualizado quando a resolução da tela muda. */
function usePixelRatio(): number {
  const [ratio, setRatio] = useState(dpr);
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(`(resolution: ${ratio}dppx)`);
    const onChange = () => setRatio(dpr());
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, [ratio]);
  return ratio;
}

export function Viewport() {
  const { t } = useTranslation();
  const doc = useDocs((s) => s.docs.find((d) => d.id === s.activeId) ?? null);
  const hasDocs = useDocs((s) => s.docs.length > 0);
  const view = useUi((s) => s.view);
  const viewSize = useUi((s) => s.viewSize);
  const page = useUi((s) => s.page);
  const background = usePrefs((p) => (p.background === "custom" ? p.customBg : BACKGROUNDS[p.background]));
  const showBg = usePrefs((p) => p.showImageBackground);
  const animFrame = useAnimatedFrame(doc, page === null);
  const pixelRatio = usePixelRatio();
  const alt = useImageAlt(doc);
  const unit = useZoomUnit(doc?.id, doc?.rev, pixelRatio);
  const frame = page ?? animFrame;

  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const buffers = useRef(new ByteLru<number, Buf>(CACHE_BYTES, (b) => b.canvas.width * b.canvas.height * 4));
  /** Último buffer pintado: continua na tela (escalado) até chegar o novo, sem piscar. */
  const shown = useRef<Buf | null>(null);
  const seq = useRef(0);
  /** Estado mais recente para o `paint` e as respostas assíncronas (atualizado antes de pintar). */
  const cur = useRef({ doc, view, viewSize, frame, showBg });

  const paint = useRef(() => {
    const cv = canvas.current;
    const { doc, view, viewSize, frame, showBg } = cur.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const k = dpr();
    const w = Math.round(viewSize.w * k);
    const h = Math.round(viewSize.h * k);
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!doc || doc.error || !view) return;
    const b = [buffers.current.get(frame), shown.current].find((x) => x?.id === doc.id);
    if (!b) return;
    const img = { x: view.panX, y: view.panY, w: doc.width * view.scale, h: doc.height * view.scale };
    let dest: { x: number; y: number; w: number; h: number };
    if (b.img.w === doc.width && b.img.h === doc.height) {
      dest = { x: img.x + b.region.x * view.scale, y: img.y + b.region.y * view.scale, w: b.region.w * view.scale, h: b.region.h * view.scale };
    } else if (b.region.w === b.img.w && b.region.h === b.img.h) {
      dest = img; // dimensões mudaram (ex.: girar): o buffer antigo inteiro ocupa a imagem nova até chegar o certo
    } else return;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    // Visualizar › Mostrar Fundo da Imagem (Lote 8): xadrez atrás da transparência.
    if (showBg) {
      ctx.fillStyle = checkerPattern(ctx, 8) ?? "#fff";
      ctx.fillRect(dest.x, dest.y, dest.w, dest.h);
    }
    // Ampliação forte: pixels nítidos; o resto suavizado.
    ctx.imageSmoothingEnabled = (dest.w * k) / b.canvas.width < 2;
    ctx.drawImage(b.canvas, dest.x, dest.y, dest.w, dest.h);
    shown.current = b;
  });

  // Tamanho da área (vem primeiro: o ajuste do documento depende dele).
  useEffect(() => {
    const el = box.current!;
    const ro = new ResizeObserver(() => {
      useUi.getState().setViewSize({ w: el.clientWidth, h: el.clientHeight });
      syncView(false);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => syncView(true), [doc?.id]);
  useEffect(() => syncView(false), [doc?.width, doc?.height, doc?.error]);

  useLayoutEffect(() => {
    cur.current = { doc, view, viewSize, frame, showBg };
    paint.current();
  });

  // A escala da tela (outro monitor, zoom do sistema) ou o que 100% significa mudou: refaz a view e o buffer.
  useEffect(() => syncView(false), [pixelRatio, unit]);

  // Indicador de zoom: aparece a cada mudança de escala e some sozinho. 100 % = Tamanho Real.
  const badge = useRef<HTMLDivElement>(null);
  const scale = view ? +(view.scale * unit).toFixed(4) : null;
  useEffect(() => {
    const el = badge.current;
    if (!el || scale === null) return;
    el.classList.add("show");
    const timer = setTimeout(() => el.classList.remove("show"), 1200);
    return () => clearTimeout(timer);
  }, [scale]);

  // Pede o buffer que falta para a view atual.
  useEffect(() => {
    if (!doc || doc.error || !view || viewSize.w <= 0) return;
    const need = needFor(view, doc, viewSize);
    const have = buffers.current.get(frame);
    if (have && satisfies(have, doc, frame, need)) return;
    const { id, rev } = doc;
    const timer = setTimeout(async () => {
      const my = ++seq.current;
      try {
        const v = await renderView(id, frame, need.outW, need.outH, need.region);
        const now = cur.current.doc;
        if (now?.id !== id || now.rev !== rev) return;
        const old = buffers.current.get(frame);
        if (old && old.id === id && old.rev === rev && old.seq > my) return;
        const b: Buf = { canvas: bufferToCanvas(v), id, rev, frame, region: need.rect, img: { w: doc.width, h: doc.height }, seq: my };
        const cache = buffers.current;
        for (const f of [...cache.keys()]) {
          const x = cache.get(f)!;
          if (x.id !== id || x.rev !== rev) cache.delete(f);
        }
        cache.set(frame, b);
        paint.current();
      } catch (e) {
        console.error("falha ao desenhar a imagem:", e);
      }
    }, have ? 40 : 0);
    return () => clearTimeout(timer);
  }, [doc, frame, view, viewSize, pixelRatio]);

  // Roda, pinça e arraste (listeners nativos: a roda precisa de passive: false). O botão esquerdo só
  // faz pan na ferramenta "mover" (nenhuma ferramenta de seleção) ou com Espaço pressionado; com uma
  // ferramenta de seleção, o ponteiro é da camada de seleção. O botão do meio sempre faz pan.
  useEffect(() => {
    const el = box.current!;
    let drag: { x: number; y: number; id: number } | null = null;
    let space = false;
    const setSpace = (on: boolean) => {
      space = on;
      el.classList.toggle("space-pan", on);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" || isTyping(e.target) || e.target instanceof HTMLButtonElement) return;
      e.preventDefault(); // o Espaço arma o pan; não rola nem ativa nada
      if (!space) setSpace(true);
    };
    const onKeyUp = (e: KeyboardEvent) => e.code === "Space" && setSpace(false);
    const onBlur = () => setSpace(false);
    const selecting = () => useSelection.getState().selectionTool !== null && !space;
    const anchor = (e: MouseEvent) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
      if (e.ctrlKey) {
        // Pinça do touchpad chega como roda com ctrlKey e deltas pequenos; a roda do mouse, com ~100.
        const d = Math.max(-50, Math.min(50, e.deltaY * unit));
        zoomBy(Math.exp(-d * 0.005), anchor(e));
      } else {
        const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
        const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
        panBy(-dx * unit, -dy * unit);
      }
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 1 && (e.button !== 0 || selecting())) return;
      drag = { x: e.clientX, y: e.clientY, id: e.pointerId };
      el.classList.add("dragging");
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* ponteiro já liberado */
      }
    };
    const onMove = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      panBy(e.clientX - drag.x, e.clientY - drag.y);
      drag = { ...drag, x: e.clientX, y: e.clientY };
    };
    const onEnd = () => {
      drag = null;
      el.classList.remove("dragging");
    };
    const onDouble = (e: MouseEvent) => selecting() || toggleFitActual(anchor(e));
    const listeners: [string, EventListener, AddEventListenerOptions?][] = [
      ["wheel", onWheel as EventListener, { passive: false }],
      ["pointerdown", onDown as EventListener],
      ["pointermove", onMove as EventListener],
      ["pointerup", onEnd],
      ["pointercancel", onEnd],
      ["lostpointercapture", onEnd],
      ["dblclick", onDouble as EventListener],
    ];
    const winListeners: [string, EventListener][] = [
      ["keydown", onKeyDown as EventListener],
      ["keyup", onKeyUp as EventListener],
      ["blur", onBlur],
    ];
    for (const [n, f, o] of listeners) el.addEventListener(n, f, o);
    for (const [n, f] of winListeners) window.addEventListener(n, f);
    return () => {
      for (const [n, f] of listeners) el.removeEventListener(n, f);
      for (const [n, f] of winListeners) window.removeEventListener(n, f);
    };
  }, []);

  const overlay: OverlayProps | null =
    doc && !doc.error && view ? { scale: view.scale, panX: view.panX, panY: view.panY, imageW: doc.width, imageH: doc.height } : null;


  return (
    <div ref={box} className="viewport" data-testid="viewport" role="region" aria-label={t("viewer.label")} style={{ background }}>
      <canvas ref={canvas} className="viewport-canvas" role={alt ? "img" : undefined} aria-label={alt} aria-hidden={!alt} />
      {overlay && (
        <div className="viewport-overlay">
          <Slot name="viewport-overlay" props={overlay} />
        </div>
      )}
      {doc?.error && <DocError doc={doc} />}
      {!hasDocs && <div className="viewport-empty">{t("viewer.empty")}</div>}
      <div
        ref={badge}
        className={`zoom-badge${scale === null ? " hidden" : ""}`}
        data-testid="zoom-level"
        data-scale={scale ?? ""}
        aria-label={t("viewer.zoomLevel", { pct: Math.round((scale ?? 0) * 100) })}
      >
        {t("viewer.zoomPercent", { pct: Math.round((scale ?? 0) * 100) })}
      </div>
    </div>
  );
}
