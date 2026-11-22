// Painel Fontes (⌘T no Pré-Visualização): as famílias instaladas no sistema, tamanho e estilo.
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDocs } from "../store/docs";
import { applyStyle } from "./actions";
import { cssFamily } from "./fontCss";
import { BASE_FONTS, useSystemFonts } from "./fonts";
import { DEFAULT_FONT, type FontStyle } from "./model";
import { getSelected, useItems, useMarkup } from "./store";

/** Quantas famílias aparecem de uma vez (a busca estreita o resto). */
const SHOWN = 200;
export const FONT_SIZES = [10, 12, 14, 18, 24, 32, 48, 64];

/**
 * A fonte do texto selecionado, ou a das próximas anotações. O tamanho é sempre o da barra
 * (px de tela): o da anotação está em px da imagem e `applyStyle` converte na ida.
 */
function useCurrentFont(): FontStyle {
  const id = useDocs((s) => s.activeId);
  const items = useItems(id);
  const sel = useMarkup((s) => (id === null ? undefined : s.selected[id]));
  const style = useMarkup((s) => s.style);
  const first = id === null || !sel?.length ? undefined : items.find((a) => a.id === getSelected(id)[0] && a.kind === "text");
  return { ...DEFAULT_FONT, ...(first?.style ?? style).font, size: style.font?.size ?? DEFAULT_FONT.size };
}

export function FontsPanel() {
  const { t } = useTranslation();
  const state = useSystemFonts();
  const [q, setQ] = useState("");
  const font = useCurrentFont();
  const all = state.status === "ready" ? state.fonts : BASE_FONTS;
  const list = useMemo(() => {
    const n = q.trim().toLowerCase();
    return n ? all.filter((f) => f.toLowerCase().includes(n)) : all;
  }, [all, q]);

  return (
    <div role="dialog" aria-label={t("markup.fonts.title")} className="markup-menu fonts-panel" data-testid="fonts-panel">
      <div className="markup-menu-label">{t("markup.fonts.title")}</div>
      <input
        type="search"
        className="fonts-search"
        aria-label={t("markup.fonts.search")}
        placeholder={t("markup.fonts.search")}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {state.status === "loading" && <p className="sig-hint" role="status">{t("markup.fonts.loading")}</p>}
      {state.status === "error" && <p className="sig-error" role="alert">{t("markup.fonts.failed")}</p>}
      <ul className="fonts-list" role="listbox" aria-label={t("markup.fonts.title")}>
        {list.slice(0, SHOWN).map((f) => (
          <li key={f} role="option" aria-selected={font.family === f}>
            <button type="button" style={{ fontFamily: `${cssFamily(f)}, sans-serif` }} onClick={() => applyStyle({ font: { family: f } })}>
              {f}
            </button>
          </li>
        ))}
      </ul>
      <p className="sig-hint" hidden={list.length <= SHOWN}>{t("markup.fonts.more", { n: list.length - SHOWN })}</p>
      {list.length === 0 && state.status === "ready" && <p className="sig-hint">{t("markup.fonts.none")}</p>}
      <div className="markup-menu-row">
        <label>
          {t("markup.fontSize")}
          <select value={font.size} onChange={(e) => applyStyle({ font: { size: Number(e.target.value) } })}>
            {(FONT_SIZES.includes(font.size) ? FONT_SIZES : [...FONT_SIZES, font.size].sort((a, b) => a - b)).map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
        {(["bold", "italic", "underline"] as const).map((k) => (
          <button key={k} type="button" role="menuitemcheckbox" aria-checked={font[k]} aria-label={t(`markup.${k}`)} title={t(`markup.${k}`)} className={`markup-font-${k}`} onClick={() => applyStyle({ font: { [k]: !font[k] } })}>
            {t(`markup.${k}Short`)}
          </button>
        ))}
      </div>
    </div>
  );
}
