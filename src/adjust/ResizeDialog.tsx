import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DocInfo, ResizeFilter } from "../ipc/types";
import { useDocs } from "../store/docs";
import { RESIZE_PRESETS, UNITS, fromPixels, linkDims, toPixels, type Unit } from "./units";
import "./adjust.css";

const DEFAULT_DPI = 72;
const MAX_PIXELS = 2 ** 31;

/** Ponto de extensão da Tarefa 11: troca por `estimate_size` quando existir. */
export type SizeEstimator = (w: number, h: number) => number;
export const rawSizeBytes: SizeEstimator = (w, h) => w * h * 4;

const round = (v: number) => Math.round(v * 100) / 100;
const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);

interface Props {
  doc: DocInfo;
  onClose: () => void;
  estimate?: SizeEstimator;
}

export function ResizeDialog({ doc, onClose, estimate = rawSizeBytes }: Props) {
  const { t } = useTranslation();
  const titleId = useId();
  const [size, setSize] = useState({ w: doc.width, h: doc.height });
  const [unit, setUnit] = useState<Unit>("px");
  const [dpi, setDpi] = useState(DEFAULT_DPI);
  const [link, setLink] = useState(true);
  const [resample, setResample] = useState(true);
  const [filter, setFilter] = useState<ResizeFilter>("lanczos3");
  const [error, setError] = useState<string | null>(null);

  const orig = { w: doc.width, h: doc.height };
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
  const bytes = estimate(eff.w, eff.h);
  const tooBig = resample && size.w * size.h > MAX_PIXELS;
  const unchanged = resample ? size.w === orig.w && size.h === orig.h : dpi === DEFAULT_DPI;

  const ok = async () => {
    try {
      await useDocs.getState().applyOp(doc.id, { type: "resize", data: { w: eff.w, h: eff.h, filter, dpi } });
      onClose();
    } catch {
      setError(t("resize.failed"));
    }
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
      <div className="adjust-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={(e) => e.key === "Escape" && onClose()}>
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
        {tooBig && <p role="alert" className="adjust-error">{t("resize.tooBig")}</p>}
        {error && <p role="alert" className="adjust-error">{error}</p>}

        <div className="adjust-actions">
          <span className="adjust-spacer" />
          <button type="button" onClick={onClose}>{t("adjust.cancel")}</button>
          <button type="button" className="adjust-ok" onClick={ok} disabled={tooBig || unchanged}>{t("adjust.ok")}</button>
        </div>
      </div>
    </div>
  );
}
