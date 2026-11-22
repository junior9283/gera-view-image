import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as ipc from "../ipc/commands";
import { NEUTRAL_ADJUST, type ColorAdjust, type DocId, type Histogram, type Levels } from "../ipc/types";
import { useShownPage } from "../markup/pages";
import { useDocs } from "../store/docs";
import { applyToTargets } from "../sidebar/batch";
import { batchTargets, withActive } from "../sidebar/selection";
import { bufferToCanvas } from "../viewer/paint";
import "./adjust.css";

/** Intervalo mínimo entre chamadas de `preview_adjust`. */
export const PREVIEW_THROTTLE_MS = 50;
const PREVIEW_W = 480;
const PREVIEW_H = 320;

type SliderKey = Exclude<keyof ColorAdjust, "levels">;
const SLIDERS: { key: SliderKey; min: number; max: number; step: number }[] = [
  { key: "exposure", min: -3, max: 3, step: 0.01 },
  { key: "contrast", min: -1, max: 1, step: 0.01 },
  { key: "highlights", min: -1, max: 1, step: 0.01 },
  { key: "shadows", min: -1, max: 1, step: 0.01 },
  { key: "temperature", min: -1, max: 1, step: 0.01 },
  { key: "tint", min: -1, max: 1, step: 0.01 },
  { key: "saturation", min: -1, max: 1, step: 0.01 },
  { key: "sepia", min: 0, max: 1, step: 0.01 },
  { key: "sharpness", min: 0, max: 1, step: 0.01 },
];

const NEUTRAL_KEYS = Object.keys(NEUTRAL_ADJUST).filter((k) => k !== "levels") as SliderKey[];
const isNeutral = (a: ColorAdjust) =>
  NEUTRAL_KEYS.every((k) => a[k] === NEUTRAL_ADJUST[k]) &&
  a.levels.black === NEUTRAL_ADJUST.levels.black &&
  a.levels.gamma === NEUTRAL_ADJUST.levels.gamma &&
  a.levels.white === NEUTRAL_ADJUST.levels.white;

function drawHistogram(canvas: HTMLCanvasElement, h: Histogram) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const max = Math.max(1, ...h.l.slice(1, 255));
  const series: [number[], string][] = [
    [h.r, "rgb(255 80 80 / 0.45)"],
    [h.g, "rgb(80 255 80 / 0.45)"],
    [h.b, "rgb(80 120 255 / 0.45)"],
    [h.l, "rgb(220 220 220 / 0.6)"],
  ];
  for (const [bins, color] of series) {
    ctx.fillStyle = color;
    bins.forEach((v, i) => {
      const bh = Math.min(1, v / max) * canvas.height;
      ctx.fillRect(i, canvas.height - bh, 1, bh);
    });
  }
}

interface Props {
  docId: DocId;
  onClose: () => void;
}

/**
 * Janela flutuante de Ajustar Cor. A prévia mostra a imagem ajustada num canvas do próprio painel
 * (`preview_adjust`, com *throttle*); o documento só muda com `apply_op(Adjust)` ao clicar em OK.
 */
export function AdjustColorPanel({ docId, onClose }: Props) {
  const { t } = useTranslation();
  const titleId = useId();
  // O painel acompanha a página exibida, a que o OK ajusta.
  const page = useShownPage(useDocs((s) => s.docs.find((d) => d.id === docId)));
  const [adj, setAdj] = useState<ColorAdjust>(NEUTRAL_ADJUST);
  const [hist, setHist] = useState<Histogram | null>(null);
  const [error, setError] = useState<string | null>(null);
  const histRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastRun = useRef(0);
  const seq = useRef(0);

  const runPreview = useCallback(
    (a: ColorAdjust) => {
      lastRun.current = Date.now();
      const mine = ++seq.current;
      ipc
        .previewAdjust(docId, a, PREVIEW_W, PREVIEW_H, page)
        .then((v) => mine === seq.current && previewRef.current && bufferToCanvas(v, previewRef.current))
        .catch(() => mine === seq.current && setError(t("adjust.previewFailed")));
    },
    [docId, page, t],
  );

  // Throttle com borda final: dispara já se passou o intervalo; senão agenda o último valor.
  useEffect(() => {
    clearTimeout(timer.current);
    const wait = Math.max(0, lastRun.current + PREVIEW_THROTTLE_MS - Date.now());
    timer.current = setTimeout(() => runPreview(adj), wait);
    return () => clearTimeout(timer.current);
  }, [adj, runPreview]);

  useEffect(() => {
    let alive = true;
    ipc
      .histogram(docId, page)
      .then((h) => alive && setHist(h))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [docId, page]);

  useEffect(() => {
    if (hist && histRef.current) drawHistogram(histRef.current, hist);
  }, [hist]);

  const targets = useMemo(() => withActive(batchTargets(), docId), [docId]);
  const setSlider = (key: SliderKey, value: number) => setAdj((a) => ({ ...a, [key]: value }));
  const setLevels = (patch: Partial<Levels>) => setAdj((a) => ({ ...a, levels: { ...a.levels, ...patch } }));
  const levels = adj.levels;

  const auto = () =>
    ipc
      .autoLevels(docId, page)
      .then((a) => setAdj(a))
      .catch(() => setError(t("adjust.autoFailed")));

  const ok = async () => {
    if (isNeutral(adj)) return onClose();
    // Com várias miniaturas selecionadas, o mesmo ajuste vai para todas (cada uma com o próprio desfazer).
    const failedAll = await applyToTargets(targets, () => ({ type: "adjust", data: adj })).then((r) => r.done === 0, () => true);
    if (failedAll) setError(t("adjust.applyFailed"));
    else onClose();
  };

  return (
    <div
      className="adjust-panel"
      role="dialog"
      aria-labelledby={titleId}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        // O Esc é do painel: não pode também desmarcar a seleção pelo keymap global.
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <h3 id={titleId}>{t("adjust.title")}</h3>

      <canvas ref={previewRef} className="adjust-preview" aria-label={t("adjust.preview")} />

      <div className="adjust-hist">
        <canvas ref={histRef} width={256} height={64} aria-label={t("adjust.histogram")} />
        <input
          type="range" min={0} max={254} step={1} value={levels.black}
          aria-label={t("adjust.levelBlack")}
          onChange={(e) => setLevels({ black: Math.min(Number(e.target.value), levels.white - 1) })}
        />
        <input
          type="range" min={0.1} max={3} step={0.01} value={levels.gamma}
          aria-label={t("adjust.levelGamma")}
          onChange={(e) => setLevels({ gamma: Number(e.target.value) })}
        />
        <input
          type="range" min={1} max={255} step={1} value={levels.white}
          aria-label={t("adjust.levelWhite")}
          onChange={(e) => setLevels({ white: Math.max(Number(e.target.value), levels.black + 1) })}
        />
      </div>

      {SLIDERS.map(({ key, min, max, step }) => (
        <label key={key} className="adjust-row">
          <span>{t(`adjust.${key}`)}</span>
          <input
            type="range" min={min} max={max} step={step} value={adj[key]}
            onChange={(e) => setSlider(key, Number(e.target.value))}
          />
          <output>{adj[key].toFixed(2)}</output>
        </label>
      ))}

      {targets.length > 1 && <p className="adjust-size">{t("adjust.batchHint", { count: targets.length })}</p>}
      {error && <p role="alert" className="adjust-error">{error}</p>}

      <div className="adjust-actions">
        <button type="button" onClick={auto}>{t("adjust.auto")}</button>
        <button type="button" onClick={() => setAdj(NEUTRAL_ADJUST)} disabled={isNeutral(adj)}>{t("adjust.reset")}</button>
        <span className="adjust-spacer" />
        <button type="button" onClick={onClose}>{t("adjust.cancel")}</button>
        <button type="button" className="adjust-ok" onClick={ok}>{t("adjust.ok")}</button>
      </div>
    </div>
  );
}
