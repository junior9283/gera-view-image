import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import type { DocId, DocInfo } from "../ipc/types";
import { useDocs } from "../store/docs";
import { useUi } from "../store/ui";
import { activate } from "../viewer/actions";
import { Thumb } from "./Thumb";
import "./sidebar.css";

const SIZE = 128;
const PAGE_SIZE = 64;
/** Páginas listadas por documento (GIF longo não vira uma lista de centenas de itens). */
const MAX_PAGES = 100;
const DRAG_START_PX = 5;

/**
 * Reordenação por arraste com eventos de ponteiro (o DnD HTML5 disputa com o drag-and-drop de
 * arquivos do Tauri). Arrastar para fora da janela não exporta o arquivo: o Tauri 2 não traz
 * `startDrag` no núcleo, então só reordena.
 */
function useReorder(list: React.RefObject<HTMLDivElement | null>) {
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
    const move = (ev: PointerEvent) => {
      if (!dragged.current && Math.abs(ev.clientY - startY) < DRAG_START_PX) return;
      dragged.current = true;
      target = indexAt(ev.clientY);
      setDrop(target);
    };
    const end = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      setDrop(null);
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

export function Sidebar() {
  const { t } = useTranslation();
  const docs = useDocs((s) => s.docs);
  const activeId = useDocs((s) => s.activeId);
  const page = useUi((s) => s.page);
  const list = useRef<HTMLDivElement>(null);
  const { drop, onPointerDown, wasDrag } = useReorder(list);

  const pages = (d: DocInfo) => (d.frames > 1 && !d.error ? Array.from({ length: Math.min(d.frames, MAX_PAGES) }, (_, i) => i) : []);

  return (
    <aside className="sidebar" aria-label={t("sidebar.label")} data-testid="sidebar">
      <div ref={list} className="sidebar-list">
        {docs.map((d, i) => (
          <div key={d.id} className="sidebar-doc">
            {drop === i && <div className="drop-line" />}
            <button
              type="button"
              data-doc-index={i}
              className={`sidebar-item${d.id === activeId && page === null ? " active" : ""}`}
              onPointerDown={(e) => onPointerDown(e, d.id, i)}
              onClick={() => !wasDrag() && activate(d.id)}
              aria-current={d.id === activeId}
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
