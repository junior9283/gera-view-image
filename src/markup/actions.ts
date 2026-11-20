// Ações de anotação que entram no desfazer (cada uma é um passo).
import type { DocId } from "../ipc/types";
import { pushMarkup } from "./history";
import { moveItems, restyle, type Annotation, type StylePatch } from "./model";
import { getItems, getSelected, useMarkup } from "./store";

const same = (a: Annotation[], b: Annotation[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Passa as anotações para `next` como um passo do desfazer. `before` é o estado de antes
 * (padrão: o atual); o arrasto passa o do início, porque já mexeu ao vivo.
 */
export function commit(id: DocId, next: Annotation[], before: Annotation[] = getItems(id)): void {
  if (same(before, next)) {
    if (getItems(id) !== before) useMarkup.getState().setItems(id, before);
    return;
  }
  pushMarkup(id, before, next);
  useMarkup.getState().setItems(id, next);
}

export function addAnnotation(id: DocId, a: Annotation, select = true): void {
  commit(id, [...getItems(id), a]);
  if (select) useMarkup.getState().select(id, [a.id]);
}

export function replaceAnnotation(id: DocId, a: Annotation, before?: Annotation[]): void {
  commit(id, getItems(id).map((x) => (x.id === a.id ? a : x)), before);
}

export function moveSelected(id: DocId, dx: number, dy: number): void {
  commit(id, moveItems(getItems(id), getSelected(id), dx, dy));
}

/** Muda o estilo das selecionadas (um passo) e o estilo das próximas anotações. */
export function restyleSelected(id: DocId | null, patch: StylePatch): void {
  useMarkup.getState().setStyle(patch);
  if (id === null) return;
  const sel = getSelected(id);
  if (sel.length) commit(id, restyle(getItems(id), sel, patch));
}

export function deleteSelected(id: DocId): boolean {
  const sel = new Set(getSelected(id));
  if (!sel.size) return false;
  commit(id, getItems(id).filter((a) => !sel.has(a.id)));
  useMarkup.getState().select(id, []);
  return true;
}
