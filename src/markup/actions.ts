// Ações de anotação que entram no desfazer (cada uma é um passo).
import type { DocId } from "../ipc/types";
import { useDocs } from "../store/docs";
import { useUi } from "../store/ui";
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

export function moveSelected(id: DocId, dx: number, dy: number): void {
  commit(id, moveItems(getItems(id), getSelected(id), dx, dy));
}

/** Muda o estilo das selecionadas (um passo só); `patch` em px da imagem. */
export function restyleSelected(id: DocId, patch: StylePatch): void {
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

/**
 * Aplica o estilo às próximas anotações e às selecionadas. A barra fala em px de tela;
 * as selecionadas recebem o valor convertido pela escala atual.
 */
export function applyStyle(patch: StylePatch): void {
  useMarkup.getState().setStyle(patch);
  const id = useDocs.getState().activeId;
  if (id === null) return;
  const scale = useUi.getState().view?.scale ?? 1;
  const img: StylePatch = { ...patch };
  if (patch.width !== undefined) img.width = patch.width / scale;
  if (patch.font?.size !== undefined) img.font = { ...patch.font, size: patch.font.size / scale };
  restyleSelected(id, img);
}

/** Troca as selecionadas por `f(anotação)` como um passo só do desfazer (inspetor de propriedades). */
export function updateSelected(id: DocId, f: (a: Annotation) => Annotation): void {
  const sel = new Set(getSelected(id));
  if (sel.size) commit(id, getItems(id).map((a) => (sel.has(a.id) ? f(a) : a)));
}
