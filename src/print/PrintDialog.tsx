// Diálogo Imprimir, como o do Pré-Visualização: prévia da página ao lado das opções da imagem. A
// impressora, o intervalo e o resto ficam no diálogo de impressão do sistema, aberto em seguida.
import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { notify, notifyError } from "../chrome/notify";
import * as ipc from "../ipc/commands";
import type { DocId, PrintOptions, PrintPreview, PrintPreviewItem, ViewBuffer } from "../ipc/types";
import { useModal } from "../lib/modal";
import { bufferToCanvas } from "../viewer/paint";
import { closePrint, flattenedIds, hasMarkup, jobName, usePrintUi } from "./print";
import "../file/file.css";
import "./print.css";

const PAPERS = [
  "iso_a4", "na_letter", "na_legal", "iso_a3", "iso_a5", "iso_a6", "iso_b5", "na_index-4x6", "na_5x7",
] as const;
const PER_PAGE = [1, 2, 4, 6, 9, 16] as const;
const MAX_COPIES = 999;
const MAX_SCALE = 1000;
const THUMB_PX = 512;

/** Papel mais comum no país do idioma do sistema. */
export const defaultPaper = (locale: string): string => (/-(US|CA|MX|PH|CL|CO|VE)$/i.test(locale) ? "na_letter" : "iso_a4");

const defaults = (): PrintOptions => ({
  copies: 1, scalePercent: null, fit: "whole", autoRotate: true, perPage: 1,
  paper: defaultPaper(navigator.language), orientation: "portrait",
});

/** Última escolha desta sessão (as cópias sempre voltam a 1). */
let last: PrintOptions | null = null;
/** Só para testes. */
export const resetPrintOptionsForTests = () => {
  last = null;
};

type Thumbs = (id: DocId, frame: number) => Promise<ViewBuffer>;

/** Miniatura no lugar da imagem; a girada é desenhada deitada e virada 90° no sentido horário. */
function PreviewImage({ item, thumbs }: { item: PrintPreviewItem; thumbs: Thumbs }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const { id, frame, rect, clip, rotated } = item;
  useEffect(() => {
    let live = true;
    thumbs(id, frame).then((v) => live && canvas.current && bufferToCanvas(v, canvas.current), () => {});
    return () => {
      live = false;
    };
  }, [id, frame, thumbs]);
  const pct = (v: number) => `${v * 100}%`;
  const box: CSSProperties = {
    left: pct((rect.x - clip.x) / clip.w), top: pct((rect.y - clip.y) / clip.h),
    width: pct(rect.w / clip.w), height: pct(rect.h / clip.h),
  };
  const turned: CSSProperties = {
    left: "50%", top: "50%", width: pct(rect.h / rect.w), height: pct(rect.w / rect.h),
    transform: "translate(-50%, -50%) rotate(90deg)",
  };
  return (
    <div className="print-image" style={box}>
      <canvas ref={canvas} style={rotated ? turned : undefined} />
    </div>
  );
}

function Preview({ preview, page, thumbs }: { preview: PrintPreview; page: number; thumbs: Thumbs }) {
  const { t } = useTranslation();
  const { paperW, paperH } = preview;
  return (
    <div
      className="print-paper" role="img" aria-label={t("file.print.preview")} data-testid="print-paper"
      style={{ aspectRatio: `${paperW} / ${paperH}`, [paperW > paperH ? "width" : "height"]: "100%" }}
    >
      {preview.pages[page]?.map((item, i) => (
        <div
          key={i} className="print-cell" data-testid="print-cell"
          style={{
            left: `${(item.clip.x / paperW) * 100}%`, top: `${(item.clip.y / paperH) * 100}%`,
            width: `${(item.clip.w / paperW) * 100}%`, height: `${(item.clip.h / paperH) * 100}%`,
          }}
        >
          <PreviewImage item={item} thumbs={thumbs} />
        </div>
      ))}
    </div>
  );
}

export function PrintDialog({ ids, onClose }: { ids: DocId[]; onClose: () => void }) {
  const { t } = useTranslation();
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const [opts, setOpts] = useState<PrintOptions>(() => ({ ...(last ?? defaults()), copies: 1 }));
  const [scaleText, setScaleText] = useState(String(opts.scalePercent ?? 100));
  const [annotated] = useState(() => ids.some(hasMarkup));
  const [showMarkup, setShowMarkup] = useState(true);
  /** Cópias com as anotações achatadas (`null` enquanto são feitas). */
  const [flatIds, setFlatIds] = useState<DocId[] | null>(null);
  const printIds = annotated && showMarkup ? flatIds : ids;
  const [preview, setPreview] = useState<PrintPreview | null>(null);
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  useModal(dialog, { onClose: () => !busy && onClose() });

  const [thumbs] = useState<Thumbs>(() => {
    const cache = new Map<string, Promise<ViewBuffer>>();
    return (id: DocId, frame: number) => {
      const key = `${id}:${frame}`;
      const hit = cache.get(key) ?? ipc.thumbnail(id, frame, THUMB_PX);
      cache.set(key, hit);
      return hit;
    };
  });

  useEffect(() => {
    if (!annotated) return;
    let live = true;
    let close = async () => {};
    flattenedIds(ids).then((flat) => {
      if (!live) return void flat.close();
      close = flat.close;
      setFlatIds(flat.ids);
    }, (e) => {
      if (!live) return;
      notifyError(e);
      onClose();
    });
    return () => {
      live = false;
      void close();
    };
    // `onClose` só serve ao erro: não refaz as cópias.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, annotated]);

  useEffect(() => {
    if (!printIds) return;
    let live = true;
    ipc.printPreview(printIds, opts).then((p) => {
      if (!live) return;
      setPreview(p);
      setPage((n) => Math.min(n, Math.max(0, p.pages.length - 1)));
    }, (e) => live && notifyError(e));
    return () => {
      live = false;
    };
  }, [printIds, opts]);

  const set = (patch: Partial<PrintOptions>) => setOpts((o) => ({ ...o, ...patch }));
  const scale = (text: string) => {
    setScaleText(text);
    const v = Math.round(Number(text));
    if (v >= 1) set({ scalePercent: Math.min(v, MAX_SCALE) });
  };

  const run = async () => {
    if (!printIds || busy) return;
    setBusy(true);
    last = opts;
    try {
      // Cancelar no diálogo do sistema volta para este.
      if (await ipc.printNative(printIds, opts, jobName(ids))) {
        notify(t("file.print.sent"));
        return onClose();
      }
    } catch (e) {
      notifyError(e);
    }
    setBusy(false);
  };

  const total = preview?.pages.length ?? 0;
  return (
    <div className="file-backdrop" role="presentation">
      <div
        ref={dialog} className="file-dialog print-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}
      >
        <h3 id={titleId}>
          {ids.length > 1 ? t("file.print.titleMany", { count: ids.length }) : t("file.print.title")}
        </h3>
        <div className="print-body">
          <div className="print-preview">
            <div className="print-stage">{preview && <Preview preview={preview} page={page} thumbs={thumbs} />}</div>
            <div className="print-pager">
              <button type="button" aria-label={t("file.print.prev")} disabled={page === 0} onClick={() => setPage(page - 1)}>‹</button>
              <span data-testid="print-page">{t("file.print.page", { page: total ? page + 1 : 0, total })}</span>
              <button
                type="button" aria-label={t("file.print.next")} disabled={page + 1 >= total}
                onClick={() => setPage(page + 1)}
              >
                ›
              </button>
            </div>
          </div>
          <fieldset className="print-options" disabled={busy}>
            <label className="file-row">
              <span>{t("file.print.copies")}</span>
              <input
                type="number" min={1} max={MAX_COPIES} value={opts.copies}
                onChange={(e) => set({ copies: Math.min(MAX_COPIES, Math.max(1, Math.round(Number(e.target.value)) || 1)) })}
              />
            </label>
            <label className="file-row">
              <span>{t("file.print.paper")}</span>
              <select value={opts.paper} onChange={(e) => set({ paper: e.target.value })}>
                {PAPERS.map((p) => (
                  <option key={p} value={p}>{t(`file.print.papers.${p}`)}</option>
                ))}
              </select>
            </label>
            <label className="file-row">
              <span>{t("file.print.orientation")}</span>
              <select
                value={opts.orientation}
                onChange={(e) => set({ orientation: e.target.value as PrintOptions["orientation"] })}
              >
                <option value="portrait">{t("file.print.portrait")}</option>
                <option value="landscape">{t("file.print.landscape")}</option>
              </select>
            </label>
            <label className="file-check">
              <input type="checkbox" checked={opts.autoRotate} onChange={(e) => set({ autoRotate: e.target.checked })} />
              {t("file.print.autoRotate")}
            </label>
            {annotated && (
              <label className="file-check">
                <input type="checkbox" checked={showMarkup} onChange={(e) => setShowMarkup(e.target.checked)} />
                {t("file.print.showMarkup")}
              </label>
            )}
            <div className="print-scale">
              <label className="file-check">
                <input
                  type="radio" name={`${titleId}-scale`} checked={opts.scalePercent !== null}
                  onChange={() => scale(scaleText)}
                />
                {t("file.print.scale")}
              </label>
              <input
                type="number" min={1} max={MAX_SCALE} value={scaleText} aria-label={`${t("file.print.scale")} (%)`}
                onChange={(e) => scale(e.target.value)}
              />
              <span>%</span>
            </div>
            <label className="file-check">
              <input
                type="radio" name={`${titleId}-scale`} checked={opts.scalePercent === null}
                onChange={() => set({ scalePercent: null })}
              />
              {t("file.print.fit")}
            </label>
            <div className="print-fit">
              {(["whole", "fill"] as const).map((fit) => (
                <label key={fit} className="file-check">
                  <input
                    type="radio" name={`${titleId}-fit`} checked={opts.fit === fit} disabled={opts.scalePercent !== null}
                    onChange={() => set({ fit })}
                  />
                  {t(`file.print.${fit}`)}
                </label>
              ))}
            </div>
            <label className="file-row">
              <span>{t("file.print.perPage")}</span>
              <select value={opts.perPage} onChange={(e) => set({ perPage: Number(e.target.value) })}>
                {PER_PAGE.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
          </fieldset>
        </div>
        <div className="file-actions">
          <span className="file-spacer" />
          <button type="button" disabled={busy} onClick={onClose}>{t("file.print.cancel")}</button>
          <button
            type="button" className="file-primary" disabled={busy || !printIds} data-testid="print-ok"
            onClick={() => void run()}
          >
            {t(busy ? "file.print.printing" : "file.print.print")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Montado pelo slot `above-content`. */
export function PrintHost() {
  const ids = usePrintUi((s) => s.ids);
  return ids && <PrintDialog ids={ids} onClose={closePrint} />;
}
