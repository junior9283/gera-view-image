// Comportamento comum das miniaturas (barra lateral e folha de contatos): seleção, teclado, menu de
// contexto, reordenar, arrastar para fora e soltar arquivos numa posição.
import {
  useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent, type RefObject,
} from "react";
import { notifyError } from "../chrome/notify";
import { hasUnsaved } from "../file/dirty";
import type { DocId, DocInfo } from "../ipc/types";
import { useDocs } from "../store/docs";
import { useSelection } from "../store/selection";
import { activate, closeDocs } from "../viewer/actions";
import { registerDropHover, registerDropTarget } from "../viewer/fileDrop";
import { dragItems, dragPlan, isOutside, startDragOut } from "./dragOut";
import { copyThumbs, openAt, pasteThumbs, placeDocs } from "./files";
import { dropIndex, gridIndex, type Layout, type Point } from "./order";
import {
  effectiveSelection, selectAllThumbs, selectionAfterClick, selectionAfterMove, useThumbSelection, type Change,
} from "./selection";
import type { MenuTarget } from "./ThumbMenu";

const DRAG_START_PX = 5;
const LIST_KEYS = new Set(["ArrowDown", "ArrowUp", "Home", "End"]);

interface Options {
  /** Elemento que contém as miniaturas. */
  list: RefObject<HTMLElement | null>;
  /** Elemento que aceita arquivos soltos (a área toda, mesmo vazia). */
  area: RefObject<HTMLElement | null>;
  layout: Layout;
  /** Abrir no visor (Enter e Abrir, na folha de contatos). */
  onOpen?: (id: DocId) => void;
}

const itemsOf = (list: HTMLElement | null) => [...(list?.querySelectorAll<HTMLElement>("[data-doc-index]") ?? [])];
const boxesOf = (list: HTMLElement | null) => itemsOf(list).map((el) => el.getBoundingClientRect());
const indexAt = (list: HTMLElement | null, p: Point, layout: Layout) => dropIndex(boxesOf(list), p, layout);
const idOf = (el: Element | null): DocId | null => {
  const id = el?.closest<HTMLElement>("[data-doc-id]")?.dataset.docId;
  return id === undefined ? null : Number(id);
};

export function useThumbs({ list, area, layout, onOpen }: Options) {
  const docs = useDocs((s) => s.docs);
  const activeId = useDocs((s) => s.activeId);
  const picked = useThumbSelection((s) => s.picked);
  const selected: ReadonlySet<DocId> = new Set(effectiveSelection(docs, activeId, picked));
  const selectedIds = docs.filter((d) => selected.has(d.id)).map((d) => d.id);
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [drop, setDrop] = useState<number | null>(null);
  const dragged = useRef(false);

  const focusItem = (id: DocId | null, preventScroll = false) =>
    list.current?.querySelector<HTMLElement>(`[data-doc-id="${id}"]`)?.focus({ preventScroll });

  const apply = ({ next, activate: id }: Change) => {
    useThumbSelection.setState(next);
    if (id !== null) activate(id);
  };
  const cur = () => useThumbSelection.getState();

  // Arquivos de outro app soltos (ou em cima) daqui.
  useEffect(() => {
    const inside = (p: Point) => {
      const r = area.current?.getBoundingClientRect();
      return !!r && p.x >= r.left && p.x < r.right && p.y >= r.top && p.y < r.bottom;
    };
    const offTarget = registerDropTarget((paths, p) => {
      if (!inside(p)) return false;
      void openAt(paths, indexAt(list.current, p, layout)).catch(notifyError);
      return true;
    });
    const offHover = registerDropHover((p) => {
      const here = !!p && inside(p);
      setDrop(here ? indexAt(list.current, p, layout) : null);
      return here;
    });
    return () => {
      offTarget();
      offHover();
    };
  }, [list, area, layout]);

  // Clicar no visor tira o foco da miniatura: o Delete passa a ser da imagem (seleção, anotação).
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const el = document.activeElement;
      if (el instanceof HTMLElement && list.current?.contains(el) && (e.target as Element | null)?.closest?.(".viewport")) el.blur();
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [list]);

  /**
   * Reordenação por arraste com eventos de ponteiro (o DnD HTML5 disputa com o drag-and-drop de
   * arquivos do Tauri). Se o ponteiro sai da janela, o arraste interno acaba e começa o nativo
   * (arquivo para outro app).
   */
  const onPointerDown = (e: ReactPointerEvent, id: DocId) => {
    if (e.button !== 0) return;
    const start = { x: e.clientX, y: e.clientY };
    let target: number | null = null;
    dragged.current = false;
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      setDrop(null);
    };
    const carried = () => dragItems(useDocs.getState().docs, selected, id);
    const move = (ev: PointerEvent) => {
      if (isOutside(ev, window)) {
        stop();
        // O botão é solto em outro app: nenhum clique vem para "consumir" o arraste.
        dragged.current = false;
        void startDragOut(dragPlan(carried(), hasUnsaved)).catch(notifyError);
        return;
      }
      if (!dragged.current && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_START_PX) return;
      dragged.current = true;
      target = indexAt(list.current, { x: ev.clientX, y: ev.clientY }, layout);
      setDrop(target);
    };
    const end = (ev: PointerEvent) => {
      stop();
      // O clique do fim do arraste vem antes do próximo tique; depois dele, um clique é de verdade.
      setTimeout(() => (dragged.current = false), 0);
      if (ev.type !== "pointerup" || !dragged.current || target === null) return;
      placeDocs(selected.has(id) ? selectedIds : [id], target);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  const onClick = (e: ReactMouseEvent<HTMLElement>, id: DocId) => {
    // O clique que encerra um arraste não muda a seleção.
    const wasDrag = dragged.current;
    dragged.current = false;
    if (wasDrag) return;
    e.currentTarget.focus();
    apply(selectionAfterClick(docs, activeId, cur(), id, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey }));
  };

  /** Botão direito (ou a tecla Menu): uma miniatura fora da seleção vira a seleção; dentro dela, o menu age em todas. */
  const onContextMenu = (e: ReactMouseEvent<HTMLElement>, d: DocInfo) => {
    e.preventDefault();
    if (!selected.has(d.id)) apply({ next: { picked: [d.id], anchor: d.id }, activate: d.id });
    const r = e.currentTarget.getBoundingClientRect();
    const byKey = !e.clientX && !e.clientY;
    setMenu({
      x: byKey ? r.left + 8 : e.clientX,
      y: byKey ? r.top + 8 : e.clientY,
      pressed: d,
      ids: selected.has(d.id) ? selectedIds : [d.id],
      onOpen,
    });
  };

  const closeMenu = () => {
    const id = menu?.pressed.id ?? null;
    setMenu(null);
    requestAnimationFrame(() => document.activeElement === document.body && focusItem(id));
  };

  const closeSelected = () =>
    closeDocs(selectedIds).then(() =>
      requestAnimationFrame(() => document.activeElement === document.body && focusItem(useDocs.getState().activeId)),
    );

  /** Índice para onde a tecla leva, a partir do item focado (ou do ativo). */
  const target = (key: string): number | null => {
    const focusedId = idOf(document.activeElement);
    const at = Math.max(0, docs.findIndex((d) => d.id === (focusedId ?? activeId)));
    if (layout === "list") return LIST_KEYS.has(key) ? gridIndex(key, at, docs.length, 1, 1) : null;
    const boxes = boxesOf(list.current);
    const cols = Math.max(1, boxes.filter((b) => b.top === boxes[0].top).length);
    const pitch = (boxes[cols]?.top ?? 0) - (boxes[0]?.top ?? 0);
    const rows = pitch > 0 ? Math.floor((list.current?.clientHeight ?? 0) / pitch) : 1;
    return gridIndex(key, at, docs.length, cols, rows);
  };

  const run = (p: Promise<unknown>) => void p.catch(notifyError);

  /** `true` = a tecla é das miniaturas. */
  const onKey = (e: ReactKeyboardEvent): boolean => {
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (ctrl && !e.shiftKey && key === "a") selectAllThumbs();
    else if (ctrl && !e.shiftKey && key === "c") {
      // Com seleção na imagem (à vista ao lado da barra), Editar › Copiar copia os pixels.
      if (layout === "list" && useSelection.getState().selection) return false;
      run(copyThumbs(selectedIds));
    }
    else if (ctrl && !e.shiftKey && key === "v") run(pasteThumbs());
    else if (!ctrl && (key === "Delete" || key === "Backspace")) run(closeSelected());
    else if (onOpen && !ctrl && key === "Enter") {
      const id = idOf(document.activeElement) ?? activeId;
      if (id !== null) onOpen(id);
    }
    else if (layout === "grid" && key === " ") {
      const id = idOf(document.activeElement);
      if (id !== null) apply(selectionAfterClick(docs, activeId, cur(), id, { ctrl: true }));
    } else {
      const to = target(key);
      if (to === null || (ctrl && layout === "list")) return false;
      const move = !ctrl || e.shiftKey;
      if (move) apply(selectionAfterMove(docs, activeId, cur(), to, e.shiftKey));
      focusItem(docs[to].id);
    }
    return true;
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.altKey || e.defaultPrevented || !onKey(e)) return;
    // A tecla é das miniaturas, não da imagem (Ctrl+A, Delete, Ctrl+C).
    e.preventDefault();
    e.nativeEvent.stopPropagation();
  };

  const itemProps = (d: DocInfo, i: number) => ({
    "data-doc-index": i,
    "data-doc-id": d.id,
    onPointerDown: (e: ReactPointerEvent) => onPointerDown(e, d.id),
    onClick: (e: ReactMouseEvent<HTMLElement>) => onClick(e, d.id),
    onContextMenu: (e: ReactMouseEvent<HTMLElement>) => onContextMenu(e, d),
  });

  return { docs, activeId, selected, drop, menu, closeMenu, itemProps, onKeyDown, focusItem };
}
