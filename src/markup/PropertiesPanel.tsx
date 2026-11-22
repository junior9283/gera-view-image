// Inspetor de Marcação: propriedades da anotação selecionada (posição, tamanho, texto,
// espessura, tracejado, sombra e opacidade). Valores em pixels da imagem.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useDocs } from "../store/docs";
import { restyleSelected, updateSelected } from "./actions";
import { opacityOf, withOpacity } from "./colors";
import type { Annotation, Dash } from "./model";
import { editableBox, withBox, withText } from "./properties";
import { useItems, useMarkup } from "./store";

const DASHES: Dash[] = ["solid", "dashed", "dotted"];
const round = (n: number) => Math.round(n * 100) / 100;

/** Número que só vira alteração ao sair do campo ou com Enter (um passo do desfazer por edição). */
function NumberField({ label, value, min, onCommit }: { label: string; value: number; min?: number; onCommit: (v: number) => void }) {
  // `draft` é o que está sendo digitado; sem rascunho, mostra o valor da anotação.
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const v = Number(draft);
    if (draft.trim() !== "" && Number.isFinite(v) && (min === undefined || v >= min)) onCommit(v);
    setDraft(null);
  };
  return (
    <label className="props-field">
      {label}
      <input
        type="number"
        value={draft ?? String(round(value))}
        min={min}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
    </label>
  );
}

export function PropertiesPanel() {
  const { t } = useTranslation();
  const id = useDocs((s) => s.activeId);
  const items = useItems(id);
  const selected = useMarkup((s) => (id === null ? undefined : s.selected[id]));
  const chosen = items.filter((a) => selected?.includes(a.id));
  const one: Annotation | undefined = chosen.length === 1 ? chosen[0] : undefined;
  const box = one ? editableBox(one) : null;
  const first = chosen[0];

  return (
    <div role="dialog" aria-label={t("markup.props.title")} className="markup-menu props-panel" data-testid="props-panel">
      <div className="markup-menu-label">{t("markup.props.title")}</div>
      {id === null || !first ? (
        <p className="sig-hint">{t("markup.props.none")}</p>
      ) : (
        <>
          <p className="props-kind">{chosen.length > 1 ? t("markup.props.many", { n: chosen.length }) : t(`markup.kind.${first.kind}`)}</p>
          {one && box && (
            <div className="props-grid">
              <NumberField label="X" value={box.x} onCommit={(x) => updateSelected(id, (a) => withBox(a, { x }))} />
              <NumberField label="Y" value={box.y} onCommit={(y) => updateSelected(id, (a) => withBox(a, { y }))} />
              <NumberField label={t("markup.props.width")} value={box.w} min={1} onCommit={(w) => updateSelected(id, (a) => withBox(a, { w }))} />
              <NumberField label={t("markup.props.height")} value={box.h} min={1} onCommit={(h) => updateSelected(id, (a) => withBox(a, { h }))} />
            </div>
          )}
          {one?.kind === "text" && (
            <label className="props-field props-text">
              {t("markup.props.text")}
              <textarea
                key={`${one.id}:${one.geom.text}`}
                defaultValue={one.geom.text}
                onBlur={(e) => e.target.value !== one.geom.text && updateSelected(id, (a) => withText(a, e.target.value))}
              />
            </label>
          )}
          <NumberField label={t("markup.width")} value={first.style.width} min={0} onCommit={(width) => restyleSelected(id, { width })} />
          <label className="props-field">
            {t("markup.props.dash")}
            <select value={first.style.dash} onChange={(e) => restyleSelected(id, { dash: e.target.value as Dash })}>
              {DASHES.map((d) => (
                <option key={d} value={d}>{t(`markup.dash.${d}`)}</option>
              ))}
            </select>
          </label>
          <label className="props-field">
            <input type="checkbox" checked={first.style.shadow} onChange={(e) => restyleSelected(id, { shadow: e.target.checked })} />
            {t("markup.shadow")}
          </label>
          <label className="props-field">
            {t("markup.colors.opacity")}
            <input
              type="range"
              min={0}
              max={100}
              value={opacityOf(first.style.stroke)}
              onChange={(e) => {
                const v = Number(e.target.value);
                updateSelected(id, (a) => ({ ...a, style: { ...a.style, stroke: withOpacity(a.style.stroke, v), fill: a.style.fill && withOpacity(a.style.fill, v) } }));
              }}
            />
            <output>{opacityOf(first.style.stroke)}%</output>
          </label>
          <button type="button" onClick={() => useMarkup.getState().setMenu("colors")}>{t("markup.props.colors")}</button>
        </>
      )}
    </div>
  );
}
