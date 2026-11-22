// Painel Cores (⇧⌘C no Pré-Visualização): cor da borda, do preenchimento ou do texto, com
// conta-gotas, opacidade e cores recentes.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useDocs } from "../store/docs";
import { setPrefs, usePrefs } from "../store/prefs";
import { applyStyle } from "./actions";
import { PALETTE, opacityOf, opaque, pushRecent, withOpacity } from "./colors";
import { startEyedropper } from "./Eyedropper";
import { DEFAULT_FONT, type Style, type StylePatch } from "./model";
import { getSelected, useItems, useMarkup } from "./store";

export type ColorTarget = "stroke" | "fill" | "text";
const TARGETS: ColorTarget[] = ["stroke", "fill", "text"];

const valueOf = (s: Style, target: ColorTarget): string | null =>
  target === "stroke" ? s.stroke : target === "fill" ? s.fill : (s.font ?? DEFAULT_FONT).color;

/** Só o preenchimento aceita "sem cor" (`null`); nos outros alvos `null` não muda nada. */
const patchFor = (target: ColorTarget, color: string | null): StylePatch => {
  if (target === "fill") return { fill: color };
  if (color === null) return {};
  return target === "stroke" ? { stroke: color } : { font: { color } };
};

/** Cor atual do alvo: a da primeira anotação selecionada, ou a do estilo das próximas. */
function useCurrent(target: ColorTarget): string | null {
  const id = useDocs((s) => s.activeId);
  const items = useItems(id);
  const sel = useMarkup((s) => (id === null ? undefined : s.selected[id]));
  const style = useMarkup((s) => s.style);
  const first = id === null || !sel?.length ? undefined : items.find((a) => a.id === getSelected(id)[0]);
  return valueOf(first?.style ?? style, target);
}

export function ColorsPanel() {
  const { t } = useTranslation();
  const [target, setTarget] = useState<ColorTarget>("stroke");
  const recent = usePrefs((p) => p.recentColors);
  const current = useCurrent(target);
  const pct = current ? opacityOf(current) : 100;
  const rgb = current ? opaque(current, "#000000") : "#ffffff";

  const apply = (color: string | null) => applyStyle(patchFor(target, color));
  const remember = (color: string) => setPrefs({ recentColors: pushRecent(recent, color) });
  /** Cor nova: mantém a opacidade que estava valendo. */
  const choose = (hex: string, store = true) => {
    const c = withOpacity(hex, pct);
    apply(c);
    if (store) remember(c);
  };

  return (
    <div role="dialog" aria-label={t("markup.colors.title")} className="markup-menu colors-panel" data-testid="colors-panel">
      <div className="markup-menu-label">{t("markup.colors.title")}</div>
      <div role="tablist" className="sig-tabs">
        {TARGETS.map((k) => (
          <button key={k} type="button" role="tab" aria-selected={target === k} onClick={() => setTarget(k)}>
            {t(`markup.colors.target.${k}`)}
          </button>
        ))}
      </div>
      <div className="colors-row">
        <input
          type="color"
          aria-label={t("markup.customColor")}
          value={rgb}
          onChange={(e) => choose(e.target.value, false)}
          onBlur={(e) => remember(withOpacity(e.target.value, pct))}
        />
        <button type="button" data-testid="colors-eyedropper" onClick={() => startEyedropper((hex) => choose(hex))}>
          {t("markup.colors.eyedropper")}
        </button>
        {target === "fill" && (
          <button type="button" role="menuitemradio" aria-checked={current === null} onClick={() => apply(null)}>
            {t("markup.noFill")}
          </button>
        )}
      </div>
      <label className="colors-opacity">
        {t("markup.colors.opacity")}
        <input
          type="range"
          min={0}
          max={100}
          value={pct}
          disabled={!current}
          aria-valuetext={`${pct}%`}
          onChange={(e) => current && apply(withOpacity(current, Number(e.target.value)))}
        />
        <output>{pct}%</output>
      </label>
      <div className="markup-swatches">
        {PALETTE.map((c) => (
          <button key={c} type="button" role="menuitemradio" aria-checked={current !== null && opaque(current) === c} aria-label={c} className="markup-swatch" style={{ background: c }} onClick={() => choose(c)} />
        ))}
      </div>
      <div className="markup-menu-label">{t("markup.colors.recent")}</div>
      {recent.length === 0 ? (
        <p className="sig-hint">{t("markup.colors.noRecent")}</p>
      ) : (
        <div className="markup-swatches" data-testid="colors-recent">
          {recent.map((c) => (
            <button key={c} type="button" aria-label={c} title={c} className="markup-swatch" style={{ background: c }} onClick={() => apply(c)} />
          ))}
        </div>
      )}
    </div>
  );
}
