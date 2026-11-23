import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import type { DocId } from "../ipc/types";
import { useDocs } from "../store/docs";
import { CONTACT_MAX, CONTACT_MIN, useUi } from "../store/ui";
import { activate } from "../viewer/actions";
import { BatchStatus } from "./BatchStatus";
import { marqueeHits, type Point } from "./order";
import { effectiveSelection, useThumbSelection } from "./selection";
import { Thumb } from "./Thumb";
import { ThumbMenu } from "./ThumbMenu";
import { useThumbs } from "./useThumbs";
import "./sidebar.css";

/** Pede as miniaturas em degraus de 64 px para o controle de tamanho não refazer tudo a cada pixel. */
export const bucket = (px: number) => Math.ceil(px / 64) * 64;

const MARQUEE_START_PX = 5;
/** Perto da borda de cima ou de baixo, o retângulo rola a grade. */
const SCROLL_EDGE_PX = 24;

/** Mostra a imagem no visor. */
function openInViewer(id: DocId) {
  activate(id);
  useUi.getState().setSidebar("thumbs");
}

/** Seleciona `ids`; o ativo continua o mesmo se estiver entre eles. */
function pick(ids: ReadonlySet<DocId>) {
  const { docs, activeId } = useDocs.getState();
  const picked = docs.filter((d) => ids.has(d.id)).map((d) => d.id);
  useThumbSelection.setState({ picked, anchor: picked[0] ?? null });
  if (picked.length && (activeId === null || !ids.has(activeId))) activate(picked[picked.length - 1]);
}

/** Retângulo de seleção no espaço vazio da grade (Ctrl ou Shift soma ao que havia). */
function useMarquee(grid: React.RefObject<HTMLDivElement | null>, onEnd: () => void) {
  const [rect, setRect] = useState<CSSProperties | null>(null);

  const onPointerDown = (e: ReactPointerEvent) => {
    const el = grid.current;
    if (e.button !== 0 || !el || e.target !== el) return;
    const { docs, activeId } = useDocs.getState();
    const base = e.ctrlKey || e.metaKey || e.shiftKey ? effectiveSelection(docs, activeId, useThumbSelection.getState().picked) : [];
    // Em px do conteúdo, para o ponto inicial acompanhar a rolagem.
    const content = (p: { clientX: number; clientY: number }): Point => {
      const r = el.getBoundingClientRect();
      return { x: p.clientX - r.left + el.scrollLeft, y: p.clientY - r.top + el.scrollTop };
    };
    const from = content(e);
    let moved = false;
    const move = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const to = content(ev);
      if (!moved && Math.hypot(to.x - from.x, to.y - from.y) < MARQUEE_START_PX) return;
      moved = true;
      if (ev.clientY > r.bottom - SCROLL_EDGE_PX) el.scrollTop += SCROLL_EDGE_PX;
      else if (ev.clientY < r.top + SCROLL_EDGE_PX) el.scrollTop -= SCROLL_EDGE_PX;
      setRect({ left: Math.min(from.x, to.x), top: Math.min(from.y, to.y), width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y) });
      const items = [...el.querySelectorAll<HTMLElement>("[data-doc-id]")];
      const start = { x: from.x + r.left - el.scrollLeft, y: from.y + r.top - el.scrollTop };
      const hits = marqueeHits(items.map((x) => x.getBoundingClientRect()), start, { x: ev.clientX, y: ev.clientY });
      pick(new Set([...base, ...hits.map((i) => Number(items[i].dataset.docId))]));
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      setRect(null);
      if (!moved && !base.length) pick(new Set());
      onEnd();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  return { rect, onPointerDown };
}

/**
 * Folha de contatos: grade de miniaturas no lugar do visor. Listbox de seleção múltipla, com um só
 * ponto de tabulação; duplo clique ou Enter abre a imagem. As miniaturas fora da vista não guardam
 * pixels (`Thumb`).
 */
export function ContactSheet() {
  const { t } = useTranslation();
  const size = useUi((s) => s.contactSize);
  const setSize = useUi((s) => s.setContactSize);
  const grid = useRef<HTMLDivElement>(null);
  const thumbs = useThumbs({ list: grid, area: grid, layout: "grid", onOpen: openInViewer });
  const { docs, activeId, selected, drop, menu, closeMenu, itemProps, onKeyDown, focusItem } = thumbs;
  // Item focado enquanto o ativo é o mesmo (Ctrl+setas levam só o foco); senão, o ativo.
  const [focus, setFocus] = useState<{ id: DocId; active: DocId | null } | null>(null);
  const stop = focus && focus.active === activeId && docs.some((d) => d.id === focus.id) ? focus.id : (activeId ?? docs[0]?.id);
  const marquee = useMarquee(grid, () => focusItem(useDocs.getState().activeId, true));

  useEffect(() => {
    const item = grid.current?.querySelector<HTMLElement>('[tabindex="0"]');
    if (document.activeElement === document.body) item?.focus();
  }, []);
  useEffect(() => {
    grid.current?.querySelector(`[data-doc-id="${activeId}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [activeId]);

  return (
    <section className="contact-sheet" aria-label={t("sidebar.contactSheet")} data-testid="contact-sheet">
      <div className="contact-toolbar">
        <BatchStatus selected={selected.size} />
        <input
          type="range"
          min={CONTACT_MIN}
          max={CONTACT_MAX}
          value={size}
          aria-label={t("sidebar.thumbSize")}
          onChange={(e) => setSize(Number(e.target.value))}
        />
      </div>
      <div
        ref={grid}
        className="contact-grid"
        role="listbox"
        aria-multiselectable="true"
        aria-label={t("sidebar.contactSheet")}
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${size}px, 1fr))` }}
        onKeyDown={onKeyDown}
        onPointerDown={marquee.onPointerDown}
      >
        {docs.map((d, i) => (
          <figure
            key={d.id}
            {...itemProps(d, i)}
            role="option"
            aria-label={d.name}
            aria-selected={selected.has(d.id)}
            aria-current={d.id === activeId || undefined}
            tabIndex={d.id === stop ? 0 : -1}
            className={[
              "contact-item",
              d.id === activeId && "active",
              selected.has(d.id) && "selected",
              drop === i && "drop-before",
              drop === docs.length && i === docs.length - 1 && "drop-after",
            ].filter(Boolean).join(" ")}
            onFocus={() => setFocus({ id: d.id, active: useDocs.getState().activeId })}
            onDoubleClick={() => openInViewer(d.id)}
          >
            <Thumb doc={d} size={size} fetchSize={bucket(size)} />
            <figcaption>{d.name}</figcaption>
          </figure>
        ))}
        {marquee.rect && <div className="marquee" aria-hidden="true" data-testid="marquee" style={marquee.rect} />}
      </div>
      {menu && <ThumbMenu target={menu} onClose={closeMenu} />}
    </section>
  );
}
