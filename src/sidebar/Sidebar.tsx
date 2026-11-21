import { useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import type { DocId, DocInfo } from "../ipc/types";
import { notifyError } from "../chrome/notify";
import { hasUnsaved } from "../file/dirty";
import { useDocs } from "../store/docs";
import { useUi } from "../store/ui";
import { activate } from "../viewer/actions";
import { dragItems, dragPlan, isOutside, startDragOut } from "./dragOut";
import { Thumb } from "./Thumb";
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

/** Seleção de várias miniaturas: Ctrl alterna, Shift estende a partir do ativo. */
function useMultiSelect(docs: DocInfo[], activeId: DocId | null) {
  const [picked, setPicked] = useState<ReadonlySet<DocId>>(new Set());
  // Sem nada escolhido, a seleção é o documento ativo; ids de documentos fechados caem fora.
  const open = new Set(docs.map((d) => d.id));
  const kept = [...picked].filter((id) => open.has(id));
  const selected: ReadonlySet<DocId> = new Set(kept.length ? kept : activeId !== null ? [activeId] : []);

  const onClick = (e: ReactMouseEvent, id: DocId, index: number) => {
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected);
      if (!next.delete(id)) next.add(id);
      setPicked(next);
      if (next.has(id)) activate(id);
      return;
    }
    const from = docs.findIndex((d) => d.id === activeId);
    if (e.shiftKey && from >= 0) {
      const [a, b] = from < index ? [from, index] : [index, from];
      setPicked(new Set(docs.slice(a, b + 1).map((d) => d.id)));
    } else {
      setPicked(new Set([id]));
    }
    activate(id);
  };

  return { selected, onClick };
}

export function Sidebar() {
  const { t } = useTranslation();
  const docs = useDocs((s) => s.docs);
  const activeId = useDocs((s) => s.activeId);
  const page = useUi((s) => s.page);
  const list = useRef<HTMLDivElement>(null);
  const { selected, onClick } = useMultiSelect(docs, activeId);
  const onOut = (id: DocId) =>
    void startDragOut(dragPlan(dragItems(useDocs.getState().docs, selected, id), hasUnsaved)).catch(notifyError);
  const { drop, onPointerDown, wasDrag } = useReorder(list, onOut);

  const pages = (d: DocInfo) => (d.frames > 1 && !d.error ? Array.from({ length: Math.min(d.frames, MAX_PAGES) }, (_, i) => i) : []);
  const many = selected.size > 1;

  return (
    <aside className="sidebar" aria-label={t("sidebar.label")} data-testid="sidebar">
      <div ref={list} className="sidebar-list">
        {docs.map((d, i) => (
          <div key={d.id} className="sidebar-doc">
            {drop === i && <div className="drop-line" />}
            <button
              type="button"
              data-doc-index={i}
              className={`sidebar-item${d.id === activeId && page === null ? " active" : ""}${many && selected.has(d.id) ? " selected" : ""}`}
              onPointerDown={(e) => onPointerDown(e, d.id, i)}
              onClick={(e) => !wasDrag() && onClick(e, d.id, i)}
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
    </aside>
  );
}
