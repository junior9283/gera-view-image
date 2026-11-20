import { useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cropToSelection } from "../select/actions";
import type { SelectionTool } from "../select/tools";
import { useDocs } from "../store/docs";
import { useSelection } from "../store/selection";
import { useUi } from "../store/ui";
import { restyleSelected } from "./actions";
import { ICONS } from "./icons";
import type { ArrowEnd, Dash, StylePatch } from "./model";
import { SignaturePanel } from "./SignaturePanel";
import { useMarkup, type BarMenu, type ShapeTool, type Tool } from "./store";

const SELECTION_TOOLS: SelectionTool[] = ["rect", "ellipse", "lasso", "smartLasso", "instantAlpha"];
const SHAPES: ShapeTool[] = ["line", "arrow", "rect", "roundRect", "oval", "bubble", "star", "polygon", "loupe", "highlight", "highlightOval"];
const WIDTHS = [1, 2, 3, 5, 8, 12];
const DASHES: Dash[] = ["solid", "dashed", "dotted"];
const ENDS: ArrowEnd[] = ["none", "arrow", "circle"];
const COLORS = ["#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#0a84ff", "#af52de", "#000000", "#8e8e93", "#ffffff"];
const FONTS = ["Inter", "sans-serif", "serif", "monospace"];
const FONT_SIZES = [10, 12, 14, 18, 24, 32, 48, 64];

/**
 * Aplica o estilo às próximas anotações e às selecionadas. A barra fala em px de tela;
 * as selecionadas recebem o valor convertido pela escala atual.
 */
function applyStyle(patch: StylePatch) {
  const st = useMarkup.getState();
  st.setStyle(patch);
  const id = useDocs.getState().activeId;
  if (id === null) return;
  const scale = useUi.getState().view?.scale ?? 1;
  const img: StylePatch = { ...patch };
  if (patch.width !== undefined) img.width = patch.width / scale;
  if (patch.font?.size !== undefined) img.font = { ...patch.font, size: patch.font.size / scale };
  restyleSelected(id, img);
}

function rotateLeft() {
  const id = useDocs.getState().activeId;
  if (id !== null) void useDocs.getState().applyOp(id, { type: "rotate", data: { quarterTurns: -1 } }).catch((e) => console.error(e));
}

function BarButton({ id, label, pressed, disabled, onClick, children }: {
  id: string; label: string; pressed?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="markup-btn"
      data-testid={`markup-${id}`}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Swatches({ value, onPick, allowNone }: { value: string | null; onPick: (c: string | null) => void; allowNone?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="markup-swatches">
      {allowNone && (
        <button type="button" role="menuitemradio" aria-checked={value === null} className="markup-swatch none" aria-label={t("markup.noFill")} title={t("markup.noFill")} onClick={() => onPick(null)} />
      )}
      {COLORS.map((c) => (
        <button key={c} type="button" role="menuitemradio" aria-checked={value === c} aria-label={c} className="markup-swatch" style={{ background: c }} onClick={() => onPick(c)} />
      ))}
      <label className="markup-custom-color" title={t("markup.customColor")}>
        <input type="color" aria-label={t("markup.customColor")} value={value ?? "#ffffff"} onChange={(e) => onPick(e.target.value)} />
      </label>
    </div>
  );
}

/** Barra de Marcação (slot `below-toolbar`): ferramentas na ordem do Preview. */
export function MarkupBar() {
  const { t } = useTranslation();
  const visible = useMarkup((s) => s.visible);
  const tool = useMarkup((s) => s.tool);
  const style = useMarkup((s) => s.style);
  const menu = useMarkup((s) => s.menu);
  const hasDoc = useDocs((s) => s.docs.some((d) => d.id === s.activeId && !d.error));
  const canCrop = useSelection((s) => s.selection !== null);
  const selTool = useSelection((s) => s.selectionTool);
  const bar = useRef<HTMLDivElement>(null);

  const st = useMarkup.getState;
  const setTool = (tl: Tool) => {
    st().setTool(tl);
    st().setMenu(null);
  };
  const toggleMenu = (m: BarMenu) => st().setMenu(menu === m ? null : m);
  /** Ferramenta de seleção da imagem (Task 7): a camada de marcação larga o ponteiro. */
  const pickSelection = (s: SelectionTool) => {
    setTool("select");
    useSelection.getState().setSelectionTool(s);
  };

  // Fecha o menu ao clicar fora da barra.
  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => {
      if (!bar.current?.contains(e.target as Node)) useMarkup.getState().setMenu(null);
    };
    window.addEventListener("pointerdown", close, true);
    return () => window.removeEventListener("pointerdown", close, true);
  }, [menu]);

  if (!visible) return null;
  const font = style.font!;
  const isShape = (SHAPES as Tool[]).includes(tool);

  return (
    <div ref={bar} role="toolbar" aria-label={t("markup.bar")} className="markup-bar" data-testid="markup-bar">
      <div className="markup-group">
        <BarButton id="select" label={t("markup.tool.select")} pressed={tool === "select"} onClick={() => toggleMenu("select")}>{ICONS.select}</BarButton>
        {menu === "select" && (
          <div role="menu" className="markup-menu">
            <button type="button" role="menuitem" data-testid="markup-select-pointer" className={tool === "select" && !selTool ? "active" : undefined} onClick={() => setTool("select")}>
              {t("markup.selectTool.pointer")}
            </button>
            {SELECTION_TOOLS.map((s) => (
              <button key={s} type="button" role="menuitem" data-testid={`markup-select-${s}`} className={selTool === s ? "active" : undefined} disabled={!hasDoc} onClick={() => pickSelection(s)}>
                {t(`markup.selectTool.${s}`)}
              </button>
            ))}
          </div>
        )}
      </div>
      <BarButton id="sketch" label={t("markup.tool.sketch")} pressed={tool === "sketch"} onClick={() => setTool("sketch")}>{ICONS.sketch}</BarButton>
      <BarButton id="draw" label={t("markup.tool.draw")} pressed={tool === "draw"} onClick={() => setTool("draw")}>{ICONS.draw}</BarButton>
      <div className="markup-group">
        <BarButton id="shapes" label={t("markup.tool.shapes")} pressed={isShape} onClick={() => toggleMenu("shapes")}>{ICONS.shapes}</BarButton>
        {menu === "shapes" && (
          <div role="menu" className="markup-menu">
            {SHAPES.map((s) => (
              <button key={s} type="button" role="menuitem" data-testid={`markup-shape-${s}`} className={tool === s ? "active" : undefined} onClick={() => setTool(s)}>
                {t(`markup.kind.${s}`)}
              </button>
            ))}
          </div>
        )}
      </div>
      <BarButton id="text" label={t("markup.tool.text")} pressed={tool === "text"} onClick={() => setTool("text")}>{ICONS.text}</BarButton>
      <div className="markup-group">
        <BarButton id="signature" label={t("markup.tool.signature")} disabled={!hasDoc} onClick={() => toggleMenu("signature")}>{ICONS.signature}</BarButton>
        {menu === "signature" && <SignaturePanel onDone={() => st().setMenu(null)} />}
      </div>
      <div className="markup-group">
        <BarButton id="lineStyle" label={t("markup.tool.lineStyle")} onClick={() => toggleMenu("lineStyle")}>{ICONS.lineStyle}</BarButton>
        {menu === "lineStyle" && (
          <div role="menu" className="markup-menu">
            <div className="markup-menu-label">{t("markup.width")}</div>
            {WIDTHS.map((w) => (
              <button key={w} type="button" role="menuitemradio" aria-checked={style.width === w} onClick={() => applyStyle({ width: w })}>
                <span className="markup-width-sample" style={{ height: w }} /> {t("markup.widthPx", { px: w })}
              </button>
            ))}
            <hr />
            {DASHES.map((d) => (
              <button key={d} type="button" role="menuitemradio" aria-checked={style.dash === d} onClick={() => applyStyle({ dash: d })}>
                {t(`markup.dash.${d}`)}
              </button>
            ))}
            <hr />
            {(["arrowStart", "arrowEnd"] as const).map((k) => (
              <div key={k} className="markup-menu-row">
                <span className="markup-menu-label">{t(`markup.${k}`)}</span>
                {ENDS.map((e) => (
                  <button key={e} type="button" role="menuitemradio" aria-checked={style[k] === e} onClick={() => applyStyle({ [k]: e })}>
                    {t(`markup.end.${e}`)}
                  </button>
                ))}
              </div>
            ))}
            <hr />
            <button type="button" role="menuitemcheckbox" aria-checked={style.shadow} onClick={() => applyStyle({ shadow: !style.shadow })}>
              {t("markup.shadow")}
            </button>
          </div>
        )}
      </div>
      <div className="markup-group">
        <BarButton id="stroke" label={t("markup.tool.stroke")} onClick={() => toggleMenu("stroke")}>
          <span style={{ color: style.stroke }}>{ICONS.stroke}</span>
        </BarButton>
        {menu === "stroke" && (
          <div role="menu" className="markup-menu">
            <Swatches value={style.stroke} onPick={(c) => c && applyStyle({ stroke: c })} />
          </div>
        )}
      </div>
      <div className="markup-group">
        <BarButton id="fill" label={t("markup.tool.fill")} onClick={() => toggleMenu("fill")}>
          <span style={{ color: style.fill ?? "transparent" }} className={style.fill ? undefined : "markup-no-fill"}>{ICONS.fill}</span>
        </BarButton>
        {menu === "fill" && (
          <div role="menu" className="markup-menu">
            <Swatches value={style.fill} allowNone onPick={(c) => applyStyle({ fill: c })} />
          </div>
        )}
      </div>
      <div className="markup-group">
        <BarButton id="textStyle" label={t("markup.tool.textStyle")} onClick={() => toggleMenu("textStyle")}>{ICONS.textStyle}</BarButton>
        {menu === "textStyle" && (
          <div role="menu" className="markup-menu markup-text-menu">
            <label>
              {t("markup.font")}
              <select value={font.family} onChange={(e) => applyStyle({ font: { family: e.target.value } })}>
                {FONTS.map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
            </label>
            <label>
              {t("markup.fontSize")}
              <select value={font.size} onChange={(e) => applyStyle({ font: { size: Number(e.target.value) } })}>
                {FONT_SIZES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </label>
            <div className="markup-menu-row">
              {(["bold", "italic", "underline"] as const).map((k) => (
                <button key={k} type="button" role="menuitemcheckbox" aria-checked={font[k]} aria-label={t(`markup.${k}`)} title={t(`markup.${k}`)} className={`markup-font-${k}`} onClick={() => applyStyle({ font: { [k]: !font[k] } })}>
                  {t(`markup.${k}Short`)}
                </button>
              ))}
              {(["left", "center", "right"] as const).map((a) => (
                <button key={a} type="button" role="menuitemradio" aria-checked={font.align === a} aria-label={t(`markup.align.${a}`)} title={t(`markup.align.${a}`)} onClick={() => applyStyle({ font: { align: a } })}>
                  <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true" stroke="currentColor" strokeWidth="1.5">
                    <path d={a === "left" ? "M1 2h12M1 6h8M1 10h10" : a === "center" ? "M1 2h12M3 6h8M2 10h10" : "M1 2h12M5 6h8M3 10h10"} />
                  </svg>
                </button>
              ))}
            </div>
            <div className="markup-menu-label">{t("markup.textColor")}</div>
            <Swatches value={font.color} onPick={(c) => c && applyStyle({ font: { color: c } })} />
          </div>
        )}
      </div>
      <BarButton id="rotate" label={t("markup.tool.rotate")} disabled={!hasDoc} onClick={rotateLeft}>{ICONS.rotate}</BarButton>
      <BarButton id="crop" label={t("markup.tool.crop")} disabled={!canCrop} onClick={() => void cropToSelection().catch((e) => console.error(e))}>{ICONS.crop}</BarButton>
    </div>
  );
}
