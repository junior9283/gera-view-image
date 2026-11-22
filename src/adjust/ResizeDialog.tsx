import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { documentDpi } from "../ipc/commands";
import type { DocInfo, ResizeFilter } from "../ipc/types";
import { defaultOptions, exportFormatOf, useEstimate } from "../file/estimate";
import { useModal } from "../lib/modal";
import { applyToTargets, resizeFor, type ResizeMode } from "../sidebar/batch";
import { batchTargets, withActive } from "../sidebar/selection";
import { RESIZE_PRESETS, UNITS, fromPixels, linkDims, toPixels, type Unit } from "./units";
import "./adjust.css";

const DEFAULT_DPI = 72;
const MAX_PIXELS = 2 ** 31;

/** Estimativa síncrona fixa (testes). Sem ela, vale o `estimate_size` do Rust no formato do arquivo. */
export type SizeEstimator = (w: number, h: number) => number;
export const rawSizeBytes: SizeEstimator = (w, h) => w * h * 4;

const round = (v: number) => Math.round(v * 100) / 100;
const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);

interface Props {
  doc: DocInfo;
  onClose: () => void;
  estimate?: SizeEstimator;
}

export function ResizeDialog({ doc, onClose, estimate }: Props) {
  const { t } = useTranslation();
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  useModal(dialog, { onClose });
  const [size, setSize] = useState({ w: doc.width, h: doc.height });
  const [unit, setUnit] = useState<Unit>("px");
  // DPI do documento (arquivo ou último Ajustar Tamanho); 72 quando o arquivo não informa.
  const [docDpi, setDocDpi] = useState(DEFAULT_DPI);
  const [dpi, setDpi] = useState(DEFAULT_DPI);
  useEffect(() => {
    let live = true;
    documentDpi(doc.id).then(
      (d) => {
        if (!live || !d) return;
        setDocDpi(d);
        setDpi(d);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [doc.id]);
  const [link, setLink] = useState(true);
  const [resample, setResample] = useState(true);
  const [filter, setFilter] = useState<ResizeFilter>("lanczos3");
  const [error, setError] = useState<string | null>(null);

  const orig = { w: doc.width, h: doc.height };
  const targets = useMemo(() => withActive(batchTargets(), doc.id), [doc.id]);
  const physical = unit !== "px" && unit !== "%";
  // Sem reamostrar, as dimensões em pixels ficam fixas e a medida física só altera o DPI.
  const sizeLocked = !resample && !physical;

  const shown = (axis: "w" | "h") => round(fromPixels(size[axis], unit, dpi, orig[axis]));

  const edit = (axis: "w" | "h", text: string) => {
    const v = Number(text);
    if (!Number.isFinite(v) || v <= 0) return;
    if (!resample) {
      if (physical) setDpi(Math.max(1, round(orig[axis] / toPixels(v, unit, 1, 0))));
      return;
    }
    const px = toPixels(v, unit, dpi, orig[axis]);
    setSize(link ? linkDims(orig, axis, px) : { ...size, [axis]: Math.max(1, Math.round(px)) });
  };

  const eff = resample ? size : orig;
  const real = useEstimate(
    doc.id,
    estimate ? null : { ...defaultOptions(exportFormatOf(doc.format)), resize: [eff.w, eff.h] },
  );
  const bytes = estimate ? estimate(eff.w, eff.h) : (real ?? rawSizeBytes(eff.w, eff.h));
  const tooBig = resample && size.w * size.h > MAX_PIXELS;
  const unchanged = resample ? size.w === orig.w && size.h === orig.h : dpi === docDpi;

  const ok = async () => {
    // Várias miniaturas selecionadas: o tamanho vale para todas, cada uma com o próprio desfazer.
    const mode: ResizeMode = !resample || unit === "%" ? "ratio" : link ? "fit" : "exact";
    const failedAll = await applyToTargets(targets, (d) => ({
      type: "resize",
      data: { ...(d.id === doc.id ? eff : resizeFor(d, eff, orig, mode)), filter, dpi },
    })).then((r) => r.done === 0, () => true);
    if (failedAll) setError(t("resize.failed"));
    else onClose();
  };

  const num = (axis: "w" | "h", label: string) => (
    <label className="adjust-row">
      <span>{label}</span>
      <input
        type="number" min={0} step="any" value={shown(axis)} disabled={sizeLocked}
        onChange={(e) => edit(axis, e.target.value)}
      />
    </label>
  );

  return (
    <div className="adjust-backdrop" role="presentation">
      <div ref={dialog} className="adjust-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h3 id={titleId}>{t("resize.title")}</h3>

        <label className="adjust-row">
          <span>{t("resize.preset")}</span>
          <select
            value="" disabled={!resample}
            onChange={(e) => {
              const p = RESIZE_PRESETS[Number(e.target.value)];
              if (p) setSize({ w: p.w, h: p.h });
            }}
          >
            <option value="">{t("resize.custom")}</option>
            {RESIZE_PRESETS.map((p, i) => (
              <option key={i} value={i}>{`${p.w} × ${p.h}`}</option>
            ))}
          </select>
        </label>

        {num("w", t("resize.width"))}
        {num("h", t("resize.height"))}

        <label className="adjust-row">
          <span>{t("resize.unit")}</span>
          <select value={unit} onChange={(e) => setUnit(e.target.value as Unit)}>
            {UNITS.map((u) => (
              <option key={u} value={u}>{u}</option>
            ))}
          </select>
        </label>

        <label className="adjust-row">
          <span>{t("resize.resolution")}</span>
          <input
            type="number" min={1} step="any" value={dpi}
            onChange={(e) => Number(e.target.value) > 0 && setDpi(Number(e.target.value))}
          />
          <span>{t("resize.dpi")}</span>
        </label>

        <label className="adjust-check">
          <input type="checkbox" checked={link} onChange={(e) => setLink(e.target.checked)} />
          {t("resize.proportional")}
        </label>
        <label className="adjust-check">
          <input type="checkbox" checked={resample} onChange={(e) => setResample(e.target.checked)} />
          {t("resize.resample")}
        </label>

        {resample && (
          <label className="adjust-row">
            <span>{t("resize.filter")}</span>
            <select value={filter} onChange={(e) => setFilter(e.target.value as ResizeFilter)}>
              {(["lanczos3", "bilinear", "nearest"] as const).map((f) => (
                <option key={f} value={f}>{t(`resize.filters.${f}`)}</option>
              ))}
            </select>
          </label>
        )}

        <p className="adjust-size">{t("resize.resultSize", { size: mb(bytes) })}</p>
        {targets.length > 1 && <p className="adjust-size">{t("resize.batchHint", { count: targets.length })}</p>}
        {tooBig && <p role="alert" className="adjust-error">{t("resize.tooBig")}</p>}
        {error && <p role="alert" className="adjust-error">{error}</p>}

        <div className="adjust-actions">
          <span className="adjust-spacer" />
          <button type="button" onClick={onClose}>{t("adjust.cancel")}</button>
          <button type="button" className="adjust-ok" onClick={ok} disabled={tooBig || (unchanged && targets.length < 2)}>{t("adjust.ok")}</button>
        </div>
      </div>
    </div>
  );
}
