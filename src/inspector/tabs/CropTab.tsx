import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { DocInfo, Rect } from "../../ipc/types";
import { pageSize, useShownPage } from "../../markup/pages";
import { useSelection } from "../../store/selection";
import { CROP_UNITS, formatUnit, isEditable, maskBounds, toPx, withField, type CropUnit } from "../crop";

const FIELDS = ["x", "y", "w", "h"] as const;

/** Posição e tamanho da seleção, em px, pt, mm, cm ou pol; editáveis em retângulo e elipse. */
export function CropTab({ doc, dpi }: { doc: DocInfo; dpi: number | null }) {
  const { t } = useTranslation();
  const selection = useSelection((s) => s.selection);
  const setSelection = useSelection((s) => s.setSelection);
  const page = useShownPage(doc);
  const [unit, setUnit] = useState<CropUnit>("px");
  const bounds = selection ? maskBounds(selection) : null;
  if (!selection || !bounds) return <p className="inspector-empty">{t("inspector.crop.none")}</p>;

  const editable = isEditable(selection);
  /** Aplica o valor digitado e devolve o retângulo que ficou (o campo mostra o valor ajustado). */
  const commit = (field: keyof Rect, raw: string): Rect => {
    if (!isEditable(selection) || raw.trim() === "") return bounds;
    const px = toPx(Number(raw.replace(",", ".")), unit, dpi);
    const { w, h } = pageSize(doc, page);
    const data = withField(selection.data, field, px, w, h);
    setSelection({ type: selection.type, data });
    return data;
  };

  return (
    <>
      <label className="inspector-unit">
        <span>{t("inspector.crop.unit")}</span>
        <select value={unit} onChange={(e) => setUnit(e.target.value as CropUnit)}>
          {CROP_UNITS.map((u) => (
            <option key={u} value={u}>
              {t(`inspector.crop.unit_${u}`)}
            </option>
          ))}
        </select>
      </label>
      <div className="inspector-form">
        {FIELDS.map((f) => (
          <label key={f}>
            <span>{t(`inspector.crop.${f}`)}</span>
            <input
              // A chave refaz o campo quando a seleção ou a unidade muda por fora (arrastar na imagem).
              key={`${unit}:${formatUnit(bounds[f], unit, dpi)}`}
              type="text"
              inputMode="decimal"
              disabled={!editable}
              defaultValue={formatUnit(bounds[f], unit, dpi)}
              onBlur={(e) => {
                // Sair do campo sem mudar o texto não regrava a seleção (não refaz o arredondamento).
                if (e.target.value === formatUnit(bounds[f], unit, dpi)) return;
                e.target.value = formatUnit(commit(f, e.target.value)[f], unit, dpi);
              }}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            />
          </label>
        ))}
      </div>
      {!editable && <p className="inspector-hint">{t("inspector.crop.readOnly")}</p>}
    </>
  );
}
