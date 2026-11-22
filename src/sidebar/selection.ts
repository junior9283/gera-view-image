// Seleção de miniaturas da barra lateral (Ctrl/Shift-clique e teclado). O estado é global porque
// os comandos (girar, espelhar, Ajustar Cor/Tamanho...) agem sobre a seleção, não só sobre o ativo.
import { create } from "zustand";
import type { DocId, DocInfo } from "../ipc/types";
import { useDocs } from "../store/docs";
import { viewable } from "../viewer/actions";

export interface Pick {
  /** Ids escolhidos explicitamente (vazio = só o documento ativo). */
  picked: DocId[];
  /** Ponto de partida do Shift. */
  anchor: DocId | null;
}

export const useThumbSelection = create<Pick>(() => ({ picked: [], anchor: null }));

export interface Mods {
  ctrl?: boolean;
  shift?: boolean;
}

export interface Change {
  next: Pick;
  /** Documento a ativar (o "cursor" da barra), se mudou. */
  activate: DocId | null;
}

/**
 * Ids selecionados, na ordem da barra. Sem escolha, ou com uma escolha que não contém o ativo
 * (a navegação por outro caminho a deixou vencida), vale só o documento ativo.
 */
export function effectiveSelection(docs: DocInfo[], activeId: DocId | null, picked: readonly DocId[]): DocId[] {
  const set = new Set(picked);
  if (activeId !== null && set.has(activeId)) return docs.filter((d) => set.has(d.id)).map((d) => d.id);
  return activeId !== null && docs.some((d) => d.id === activeId) ? [activeId] : [];
}

const range = (docs: DocInfo[], a: number, b: number) =>
  docs.slice(Math.min(a, b), Math.max(a, b) + 1).map((d) => d.id);

/** Clique numa miniatura: Ctrl alterna, Shift estende a partir da âncora, sem modificador seleciona só ela. */
export function selectionAfterClick(
  docs: DocInfo[],
  activeId: DocId | null,
  cur: Pick,
  id: DocId,
  { ctrl, shift }: Mods,
): Change {
  const current = effectiveSelection(docs, activeId, cur.picked);
  if (ctrl) {
    const next = new Set(current);
    const added = !next.delete(id);
    if (added) next.add(id);
    const picked = docs.filter((d) => next.has(d.id)).map((d) => d.id);
    // Tirar o ativo da seleção: o cursor passa para um item que sobrou.
    const activate = added ? id : id === activeId ? (picked[picked.length - 1] ?? null) : null;
    return { next: { picked, anchor: id }, activate };
  }
  const to = docs.findIndex((d) => d.id === id);
  // Âncora que saiu da seleção (a navegação mudou o ativo por outro caminho) não vale mais.
  const anchor = cur.anchor !== null && current.includes(cur.anchor) ? cur.anchor : activeId;
  const from = docs.findIndex((d) => d.id === anchor);
  if (shift && from >= 0 && to >= 0) return { next: { picked: range(docs, from, to), anchor }, activate: id };
  return { next: { picked: [id], anchor: id }, activate: id };
}

export type NavKey = "ArrowUp" | "ArrowDown" | "Home" | "End";

/** Setas/Home/End: movem o cursor (documento ativo); com Shift, estendem a partir da âncora. */
export function selectionAfterKey(
  docs: DocInfo[],
  activeId: DocId | null,
  cur: Pick,
  key: NavKey,
  shift: boolean,
): Change | null {
  if (!docs.length) return null;
  const at = Math.max(0, docs.findIndex((d) => d.id === activeId));
  const to = key === "Home" ? 0 : key === "End" ? docs.length - 1 : Math.max(0, Math.min(docs.length - 1, at + (key === "ArrowDown" ? 1 : -1)));
  const id = docs[to].id;
  if (!shift) return { next: { picked: [id], anchor: id }, activate: id };
  const anchor = cur.anchor !== null && effectiveSelection(docs, activeId, cur.picked).includes(cur.anchor) ? cur.anchor : docs[at].id;
  const from = docs.findIndex((d) => d.id === anchor);
  return { next: { picked: range(docs, from < 0 ? at : from, to), anchor }, activate: id };
}

/** Ids em que uma ação em lote age: a seleção da barra, sem documentos com erro. */
export function batchTargets(): DocId[] {
  const { docs, activeId } = useDocs.getState();
  const ids = effectiveSelection(docs, activeId, useThumbSelection.getState().picked);
  const ok = new Set(docs.filter(viewable).map((d) => d.id));
  return ids.filter((id) => ok.has(id));
}

/** Alvos de um diálogo que abriu para `activeId`: a seleção, se ela contém o documento; senão, só ele. */
export const withActive = (ids: DocId[], activeId: DocId): DocId[] => (ids.includes(activeId) ? ids : [activeId]);
