// Camada do visor com a prévia de Ajustar Cor: cobre a região visível da imagem, que fica escondida
// embaixo (senão o alfa mostraria o original através do ajuste).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { previewAdjust } from "../ipc/commands";
import type { ColorAdjust, DocInfo, Rect } from "../ipc/types";
import type { OverlayProps } from "../lib/slots";
import { shownPage } from "../markup/pages";
import { useDocs } from "../store/docs";
import { usePrefs } from "../store/prefs";
import { useUi } from "../store/ui";
import { bufferToCanvas, dpr, paintBuffer } from "../viewer/paint";
import { contains, visibleRegion, type Size } from "../viewer/zoom";
import { isNeutral } from "./neutral";
import { clearPreview, useAdjustPreview, type AdjustPreview } from "./preview";
import "./adjust.css";

/** Intervalo mínimo entre pedidos de prévia. */
export const PREVIEW_THROTTLE_MS = 50;
/** Teto de pixels enquanto o controle anda; parado por `SETTLE_MS`, vem a resolução da tela. */
export const LIVE_PIXELS = 1_000_000;
export const FULL_PIXELS = 8_000_000;
export const SETTLE_MS = 250;

interface Job {
  seq: number;
  adjust: ColorAdjust;
  region: Rect;
  /** A região é a imagem inteira. */
  whole: boolean;
  out: Size;
}

interface Shown {
  seq: number;
  canvas: HTMLCanvasElement;
  region: Rect;
}

/** Reduz `s` (na proporção) para caber em `cap` pixels. */
function limit(s: Size, cap: number): Size {
  const k = Math.min(1, Math.sqrt(cap / (s.w * s.h)));
  return { w: Math.max(1, Math.floor(s.w * k)), h: Math.max(1, Math.floor(s.h * k)) };
}

/** O canvas do visor, embaixo da camada. */
const baseCanvas = (el: Element | null) =>
  el?.closest(".viewport")?.querySelector<HTMLElement>(".viewport-canvas");

/** Quanto falta para poder pedir de novo. */
const throttleWait = (last: number) => Math.max(0, last + PREVIEW_THROTTLE_MS - Date.now());

interface LayerProps extends OverlayProps {
  doc: DocInfo;
  preview: AdjustPreview;
  frame: number;
}

function Layer({ doc, preview, frame, scale, panX, panY, imageW, imageH }: LayerProps) {
  const { t } = useTranslation();
  const viewSize = useUi((s) => s.viewSize);
  const checker = usePrefs((p) => p.showImageBackground);
  const cv = useRef<HTMLCanvasElement>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const { adjust, frozenRev } = preview;
  const frozen = frozenRev !== null;

  const region = visibleRegion({ scale, panX, panY, mode: "free" }, { w: imageW, h: imageH }, viewSize);
  const { x, y, w, h } = region;

  /** Fila de um pedido: enquanto um está em andamento, só o mais novo espera. */
  const queue = useRef({ alive: true, busy: false, next: null as Job | null, seq: 0, last: 0, frozen });
  useLayoutEffect(() => {
    queue.current.frozen = frozen;
    if (frozen) queue.current.next = null;
  }, [frozen]);
  useEffect(() => {
    const q = queue.current;
    q.alive = true;
    return () => {
      q.alive = false;
      q.next = null;
    };
  }, []);

  const { id, rev } = doc;
  useEffect(() => {
    if (frozen || w <= 0 || h <= 0) return;
    const q = queue.current;
    const density = Math.min(1, scale * dpr());
    const full = { w: Math.ceil(w * density), h: Math.ceil(h * density) };
    const job = (cap: number): Job => ({
      seq: ++q.seq, adjust, region: { x, y, w, h }, whole: w === imageW && h === imageH, out: limit(full, cap),
    });
    const fetch = (j: Job) =>
      previewAdjust(id, j.adjust, j.out.w, j.out.h, frame, j.whole ? null : j.region).then(
        (v) => {
          // Com o ajuste sendo aplicado, a resposta pode já partir da imagem ajustada.
          if (!q.alive || q.frozen) return;
          const canvas = bufferToCanvas(v);
          setShown((s) => (s && s.seq > j.seq ? s : { seq: j.seq, canvas, region: j.region }));
        },
        (e) => {
          console.error("falha na prévia do ajuste:", e);
          if (!q.alive || q.frozen) return;
          setShown(null);
          useAdjustPreview.setState({ failed: true });
        },
      );
    const run = (j: Job) => {
      if (q.busy) {
        q.next = j;
        return;
      }
      q.busy = true;
      q.last = Date.now();
      void fetch(j).finally(() => {
        q.busy = false;
        const next = q.next;
        q.next = null;
        if (next && q.alive) run(next);
      });
    };
    const live = setTimeout(() => run(job(LIVE_PIXELS)), throttleWait(q.last));
    // A nítida não entra na fila: se o controle voltar a andar, a próxima ao vivo não espera por ela.
    const sharp = full.w * full.h > LIVE_PIXELS ? setTimeout(() => void fetch(job(FULL_PIXELS)), SETTLE_MS) : undefined;
    return () => {
      clearTimeout(live);
      clearTimeout(sharp);
    };
  }, [id, rev, frame, adjust, frozen, scale, x, y, w, h, imageW, imageH]);

  const covers = !!shown && contains(shown.region, region);
  useLayoutEffect(() => {
    const base = baseCanvas(cv.current);
    if (!base || !covers) return;
    base.style.visibility = "hidden";
    return () => {
      base.style.visibility = "";
    };
  }, [covers]);

  useLayoutEffect(() => {
    if (!cv.current) return;
    const r = shown?.region;
    const dest = r && { x: panX + r.x * scale, y: panY + r.y * scale, w: r.w * scale, h: r.h * scale };
    paintBuffer(cv.current, viewSize, shown && dest ? { canvas: shown.canvas, dest } : null, checker);
  });

  // Depois do OK: some quando o visor mostrar a imagem já ajustada, ou não conseguir desenhá-la.
  useEffect(() => {
    const base = baseCanvas(cv.current);
    if (frozenRev === null || !base) return;
    const newer = (mark: string | undefined) => {
      const [docId, rev] = (mark ?? "").split(":").map(Number);
      return docId === id && rev > frozenRev;
    };
    const check = () => (newer(base.dataset.shown) || newer(base.dataset.failed)) && clearPreview();
    check();
    const watch = new MutationObserver(check);
    watch.observe(base, { attributes: true, attributeFilter: ["data-shown", "data-failed"] });
    return () => watch.disconnect();
  }, [id, frozenRev]);

  return <canvas ref={cv} className="adjust-layer" role="img" aria-label={t("adjust.preview")} hidden={!shown} />;
}

export function AdjustPreviewLayer(props: OverlayProps) {
  const preview = useAdjustPreview((s) => s.cur);
  const doc = useDocs((s) => s.docs.find((d) => d.id === s.activeId));
  // Relê a página mostrada quando ela muda.
  useUi((s) => s.page);
  if (!preview || !doc || preview.docId !== doc.id || isNeutral(preview.adjust)) return null;
  const frame = shownPage(doc.id);
  // Outra página ou outro tamanho (girar, recortar): a prévia anterior não vale.
  return <Layer key={`${frame}:${props.imageW}x${props.imageH}`} {...props} doc={doc} preview={preview} frame={frame} />;
}
