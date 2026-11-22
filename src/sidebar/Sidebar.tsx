import {
  useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import type { DocId, DocInfo } from "../ipc/types";
import { notifyError } from "../chrome/notify";
import { hasUnsaved } from "../file/dirty";
import { useDocs } from "../store/docs";
import { getPrefs, setPrefs } from "../store/prefs";
import { useUi } from "../store/ui";
import { activate } from "../viewer/actions";
import { dragItems, dragPlan, isOutside, startDragOut } from "./dragOut";
import { useBatch } from "./batch";
import {
  effectiveSelection, selectionAfterClick, selectionAfterKey, useThumbSelection, type Change, type NavKey,
} from "./selection";
import { Thumb } from "./Thumb";
import { ThumbMenu, type MenuTarget } from "./ThumbMenu";
import "./sidebar.css";

const SIZE = 128;
const PAGE_SIZE = 64;
/** Páginas listadas por documento (GIF longo não vira uma lista de centenas de itens). */
const MAX_PAGES = 100;
const DRAG_START_PX = 5;

/**
 * Reordenação por arraste com eventos de ponteiro (o DnD HTML5 disputa com o drag-and-drop de
 * arquivos do Tauri). Se o ponteiro sai da janela, o arraste interno acaba e `onOut` começa o
 * arraste nativo (arquivo para outro app).
 */
function useReorder(list: React.RefObject<HTMLDivElement | null>, onOut: (id: DocId) => void) {
  const [drop, setDrop] = useState<number | null>(null);
  const dragged = useRef(false);

  const onPointerDown = (e: ReactPointerEvent, id: DocId, from: number) => {
    if (e.button !== 0) return;
    const startY = e.clientY;
    let target: number | null = null;
    dragged.current = false;
    const indexAt = (y: number) => {
      const items = [...(list.current?.querySelectorAll<HTMLElement>("[data-doc-index]") ?? [])];
      const hit = items.find((el) => {
        const r = el.getBoundingClientRect();
        return y < r.top + r.height / 2;
      });
      return hit ? Number(hit.dataset.docIndex) : items.length;
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      setDrop(null);
    };
    const move = (ev: PointerEvent) => {
      if (isOutside(ev, window)) {
        stop();
        // O botão é solto em outro app: nenhum clique vem para "consumir" o arraste.
        dragged.current = false;
        onOut(id);
        return;
      }
      if (!dragged.current && Math.abs(ev.clientY - startY) < DRAG_START_PX) return;
      dragged.current = true;
      target = indexAt(ev.clientY);
      setDrop(target);
    };
    const end = (ev: PointerEvent) => {
      stop();
      if (ev.type === "pointerup" && dragged.current && target !== null) {
        // Arrastar vale como ordem manual: o critério de Ordenar Por não pode desfazer o arraste.
        if (getPrefs().sortBy !== "manual") setPrefs({ sortBy: "manual" });
        useDocs.getState().reorder(id, target > from ? target - 1 : target);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  /** O clique que encerra um arraste não deve ativar o item. */
  const wasDrag = () => {
    const d = dragged.current;
    dragged.current = false;
    return d;
  };

  return { drop, onPointerDown, wasDrag };
}

/** Seleção de várias miniaturas: Ctrl alterna, Shift estende, setas movem (Shift+setas estendem), Ctrl+A seleciona tudo. */
function useMultiSelect(docs: DocInfo[], activeId: DocId | null) {
  const picked = useThumbSelection((s) => s.picked);
  const selected: ReadonlySet<DocId> = new Set(effectiveSelection(docs, activeId, picked));

  const apply = ({ next, activate: id }: Change) => {
    useThumbSelection.setState(next);
    if (id !== null) activate(id);
  };
  const cur = () => useThumbSelection.getState();

  const onClick = (e: ReactMouseEvent, id: DocId) =>
    apply(selectionAfterClick(docs, activeId, cur(), id, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey }));

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.altKey) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const nav = !ctrl && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End");
    const all = ctrl && e.key.toLowerCase() === "a";
    if (!nav && !all) return;
    const change: Change | null = all
      ? { next: { picked: docs.map((d) => d.id), anchor: docs[0]?.id ?? null }, activate: null }
      : selectionAfterKey(docs, activeId, cur(), e.key as NavKey, e.shiftKey);
    // Ctrl+A aqui é "selecionar todas as miniaturas", não "selecionar tudo na imagem".
    e.preventDefault();
    e.nativeEvent.stopPropagation();
    if (!change) return;
    apply(change);
    if (change.activate !== null) {
      const id = change.activate;
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-doc-id="${id}"]`)?.focus());
    }
  };

  return { selected, onClick, onKeyDown };
}

export function Sidebar() {
  const { t } = useTranslation();
  const docs = useDocs((s) => s.docs);
  const activeId = useDocs((s) => s.activeId);
  const page = useUi((s) => s.page);
  const list = useRef<HTMLDivElement>(null);
  const { selected, onClick, onKeyDown } = useMultiSelect(docs, activeId);
  const batch = useBatch();
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const onOut = (id: DocId) =>
    void startDragOut(dragPlan(dragItems(useDocs.getState().docs, selected, id), hasUnsaved)).catch(notifyError);
  const { drop, onPointerDown, wasDrag } = useReorder(list, onOut);

  const pages = (d: DocInfo) => (d.frames > 1 && !d.error ? Array.from({ length: Math.min(d.frames, MAX_PAGES) }, (_, i) => i) : []);
  const many = selected.size > 1;

  /** Botão direito: uma miniatura fora da seleção vira a seleção; dentro dela, o menu age em todas. */
  const onContextMenu = (e: ReactMouseEvent, d: DocInfo) => {
    e.preventDefault();
    if (!selected.has(d.id)) {
      useThumbSelection.setState({ picked: [d.id], anchor: d.id });
      activate(d.id);
    }
    const ids = selected.has(d.id) ? docs.filter((x) => selected.has(x.id)).map((x) => x.id) : [d.id];
    setMenu({ x: e.clientX, y: e.clientY, pressed: d, ids });
  };

  return (
    <aside className="sidebar" aria-label={t("sidebar.label")} data-testid="sidebar">
      <div ref={list} className="sidebar-list" onKeyDown={onKeyDown}>
        {docs.map((d, i) => (
          <div key={d.id} className="sidebar-doc">
            {drop === i && <div className="drop-line" />}
            <button
              type="button"
              data-doc-index={i}
              data-doc-id={d.id}
              className={`sidebar-item${d.id === activeId && page === null ? " active" : ""}${many && selected.has(d.id) ? " selected" : ""}`}
              onPointerDown={(e) => onPointerDown(e, d.id, i)}
              onClick={(e) => !wasDrag() && onClick(e, d.id)}
              onContextMenu={(e) => onContextMenu(e, d)}
              aria-current={d.id === activeId}
              aria-pressed={many ? selected.has(d.id) : undefined}
            >
              <Thumb doc={d} size={SIZE} />
              <span className="sidebar-name">{d.name}</span>
            </button>
            {pages(d).map((f) => (
              <button
                type="button"
                key={f}
                className={`sidebar-item sidebar-page${d.id === activeId && page === f ? " active" : ""}`}
                onClick={() => activate(d.id, f)}
              >
                <Thumb doc={d} frame={f} size={PAGE_SIZE} />
                <span className="sidebar-name">{t("sidebar.page", { n: f + 1 })}</span>
              </button>
            ))}
          </div>
        ))}
        {drop === docs.length && <div className="drop-line" />}
      </div>
      {batch.running && (
        <div className="sidebar-batch" role="status">
          <progress value={batch.done} max={batch.total} />
          <span>{t("sidebar.batch.progress", { done: batch.done, total: batch.total })}</span>
        </div>
      )}
      {many && !batch.running && <div className="sidebar-count" aria-live="polite">{t("sidebar.selectedCount", { count: selected.size })}</div>}
      {menu && <ThumbMenu target={menu} onClose={() => setMenu(null)} />}
    </aside>
  );
}
