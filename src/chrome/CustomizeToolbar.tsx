// Visualizar › Personalizar Barra de Ferramentas…: arrastar itens da paleta para a barra (ou para fora
// dela, para tirar), arrastar o conjunto padrão para restaurar e escolher Ícone/Ícone e Texto/Texto.
// Arraste com eventos de ponteiro: o DnD HTML5 disputa com o drag-and-drop de arquivos do Tauri.
import { useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { useWindowEvent } from "../lib/events";
import { useModal } from "../lib/modal";
import { setPrefs, usePrefs, type Prefs } from "../store/prefs";
import { DEFAULT_TOOLBAR, TOOLBAR_ITEMS, insertIndex, moveItem, resolveToolbar, toolbarItem } from "./toolbarItems";
import "../prefs/prefs.css";

export const CUSTOMIZE_TOOLBAR_EVENT = "gvi:customize-toolbar";
const DEFAULT_SET = "__default__";
const DRAG_START_PX = 4;
/** Folga acima e abaixo da barra em que o item ainda cai nela. */
const BAR_SLACK_PX = 24;

interface Drag {
  id: string;
  x: number;
  y: number;
  /** Posição de inserção na barra (`null` = fora dela) e o x do marcador, relativo à barra. */
  index: number | null;
  markX: number;
}

function Chip({ id }: { id: string }) {
  const { t } = useTranslation();
  const item = toolbarItem(id);
  if (!item) return null;
  return (
    <>
      <span className="customize-icons" aria-hidden>
        {item.buttons.map((b) => (
          <b.Icon key={b.command} />
        ))}
      </span>
      <span className="customize-label">{t(item.label)}</span>
    </>
  );
}

const within = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi) === v;
const save = (list: string[]) => setPrefs({ toolbarItems: list });

export function CustomizeToolbar() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ids = resolveToolbar(usePrefs((p) => p.toolbarItems));
  const mode = usePrefs((p) => p.toolbarMode);
  const [drag, setDrag] = useState<Drag | null>(null);
  const bar = useRef<HTMLUListElement>(null);
  /** O clique que encerra um arraste não acrescenta o item. */
  const dragged = useRef(false);
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useWindowEvent(CUSTOMIZE_TOOLBAR_EVENT, () => setOpen(true));
  useModal(dialog, { active: open, onClose: () => setOpen(false) });
  if (!open) return null;

  const palette = TOOLBAR_ITEMS.filter((i) => !ids.includes(i.id));

  /** Onde o item cai na barra (sem contar ele mesmo). */
  const target = (id: string, x: number, y: number): Pick<Drag, "index" | "markX"> => {
    const box = bar.current?.getBoundingClientRect();
    if (!box || !within(y, box.top - BAR_SLACK_PX, box.bottom + BAR_SLACK_PX) || !within(x, box.left, box.right)) {
      return { index: null, markX: 0 };
    }
    const rects = [...bar.current!.querySelectorAll<HTMLElement>("[data-tool-id]")]
      .filter((el) => el.dataset.toolId !== id)
      .map((el) => el.getBoundingClientRect());
    const index = id === DEFAULT_SET ? 0 : insertIndex(rects, x);
    const at = rects[index];
    const markX = (at ? at.left : (rects[rects.length - 1]?.right ?? box.left)) - box.left;
    return { index, markX };
  };

  const startDrag = (e: ReactPointerEvent, id: string) => {
    if (e.button !== 0) return;
    const sx = e.clientX;
    const sy = e.clientY;
    let last: Drag | null = null;
    dragged.current = false;
    const move = (ev: PointerEvent) => {
      if (!last && Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_START_PX) return;
      dragged.current = true;
      last = { id, x: ev.clientX, y: ev.clientY, ...target(id, ev.clientX, ev.clientY) };
      setDrag(last);
    };
    const end = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      setDrag(null);
      if (ev.type !== "pointerup" || !last) return;
      if (id === DEFAULT_SET) {
        if (last.index !== null) setPrefs({ toolbarItems: null });
      } else if (last.index !== null) save(moveItem(ids, id, last.index));
      else if (ids.includes(id)) save(ids.filter((x) => x !== id));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  /** Teclado na barra: Delete tira o item; Ctrl+←/→ muda a posição. */
  const onBarKey = (e: ReactKeyboardEvent, id: string, i: number) => {
    if (e.key === "Delete" || e.key === "Backspace") save(ids.filter((x) => x !== id));
    else if (e.ctrlKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) save(moveItem(ids, id, i + (e.key === "ArrowLeft" ? -1 : 1)));
    else return;
    e.preventDefault();
  };

  return (
    <div className="prefs-backdrop" role="presentation">
      <div ref={dialog} className="prefs-dialog customize-toolbar" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <h3 id={titleId}>{t("customize.title")}</h3>

        <ul ref={bar} className={`customize-bar${drag?.index != null ? " drop" : ""}`} aria-label={t("customize.bar")} title={t("customize.barHint")}>
          {ids.map((id, i) => (
            <li key={id} data-tool-id={id} className={drag?.id === id ? "dragging" : undefined}>
              <button
                type="button"
                className="customize-chip"
                aria-description={t("customize.barHint")}
                onPointerDown={(e) => startDrag(e, id)}
                onKeyDown={(e) => onBarKey(e, id, i)}
              >
                <Chip id={id} />
              </button>
            </li>
          ))}
          {drag?.index != null && <li className="customize-mark" aria-hidden style={{ left: drag.markX }} />}
        </ul>

        <p className="customize-hint">{t("customize.paletteHint")}</p>
        <ul className="customize-palette" aria-label={t("customize.palette")}>
          {palette.map((i) => (
            <li key={i.id}>
              <button type="button" className="customize-chip" onPointerDown={(e) => startDrag(e, i.id)} onClick={() => !dragged.current && save([...ids, i.id])}>
                <Chip id={i.id} />
              </button>
            </li>
          ))}
        </ul>

        <p className="customize-hint">{t("customize.defaultHint")}</p>
        <button
          type="button"
          className="customize-default"
          aria-label={t("customize.restore")}
          onPointerDown={(e) => startDrag(e, DEFAULT_SET)}
          onClick={() => !dragged.current && setPrefs({ toolbarItems: null })}
        >
          {DEFAULT_TOOLBAR.map((id) => (
            <span key={id} className="customize-chip">
              <Chip id={id} />
            </span>
          ))}
        </button>

        <div className="prefs-actions customize-actions">
          <label>
            {t("customize.show")}{" "}
            <select value={mode} onChange={(e) => setPrefs({ toolbarMode: e.target.value as Prefs["toolbarMode"] })}>
              <option value="icon">{t("customize.modeIcon")}</option>
              <option value="iconText">{t("customize.modeIconText")}</option>
              <option value="text">{t("customize.modeText")}</option>
            </select>
          </label>
          <button type="button" onClick={() => setOpen(false)}>
            {t("customize.done")}
          </button>
        </div>
      </div>
      {drag && (
        <div className="customize-ghost" style={{ left: drag.x, top: drag.y }} aria-hidden>
          {drag.id === DEFAULT_SET ? t("customize.restore") : <Chip id={drag.id} />}
        </div>
      )}
    </div>
  );
}
