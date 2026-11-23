// Copiar, recortar, colar e duplicar anotações. O núcleo guarda o que foi copiado (as janelas são
// WebViews separados) e põe o desenho na área de transferência do sistema, para colar em outros apps;
// só devolve as anotações enquanto esse desenho ainda estiver lá: a última cópia é que vale.
import * as ipc from "../ipc/commands";
import type { DocId } from "../ipc/types";
import { useSelection } from "../store/selection";
import { useUi } from "../store/ui";
import { activeDoc, viewable } from "../viewer/actions";
import { commit } from "./actions";
import { itemsPng } from "./flatten";
import { bounds, boxOf, clamp, deserialize, newId, normBox, serialize, translate, type Annotation, type Box } from "./model";
import { onCurrentPage, pageItems, shownSize } from "./pages";
import { annotationsFocused, getItems, getSelected, useMarkup } from "./store";

/** Deslocamento da cópia, em px de tela. */
const OFFSET_PX = 12;

/** Documento ativo com anotações selecionadas (o Copiar, Recortar e Apagar são delas), ou `null`. */
export function focusedDoc(): DocId | null {
  const id = activeDoc()?.id ?? null;
  return annotationsFocused(id) ? id : null;
}

export const selectedItems = (id: DocId): Annotation[] => {
  const sel = new Set(getSelected(id));
  return getItems(id).filter((a) => sel.has(a.id));
};

export async function copyAnnotations(id: DocId): Promise<Annotation[]> {
  const items = selectedItems(id);
  if (items.length) await ipc.copyAnnotations(serialize({ items }), await itemsPng(id, items));
  return items;
}

/** Só apaga depois de a cópia dar certo, e só o que foi copiado (a seleção pode ter mudado). */
export async function cutAnnotations(id: DocId): Promise<void> {
  const cut = new Set((await copyAnnotations(id)).map((a) => a.id));
  commit(id, getItems(id).filter((a) => !cut.has(a.id)));
}

const unionBox = (items: Annotation[]): Box =>
  boxOf(items.map(bounds).flatMap((b) => [[b.x, b.y], [b.x + b.w, b.y + b.h]]));

const sameBox = (a: Box, b: Box) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

/** Cópias com outros ids, na página mostrada. */
export const cloneItems = (id: DocId, items: readonly Annotation[]): Annotation[] =>
  items.map((a) => onCurrentPage(id, { ...a, id: newId(), page: undefined }));

/** Põe `items` na página mostrada, sem cair em cima de iguais e dentro dela, e os seleciona. */
function insert(id: DocId, items: Annotation[]): void {
  const doc = activeDoc();
  if (!viewable(doc) || !items.length) return;
  const step = OFFSET_PX / (useUi.getState().view?.scale ?? 1);
  const taken = pageItems(id).map(bounds);
  let group = cloneItems(id, items);
  while (taken.some((b) => sameBox(b, bounds(group[0])))) group = group.map((a) => translate(a, step, step));
  const box = normBox(unionBox(group));
  // Veio de uma imagem (ou página) maior e ficaria fora desta: vai para o centro.
  const { w, h } = shownSize(doc);
  if (box.x >= w || box.y >= h || box.x + box.w <= 0 || box.y + box.h <= 0) {
    const center = (size: number, max: number) => clamp((max - size) / 2, 0, max);
    const [dx, dy] = [center(box.w, w) - box.x, center(box.h, h) - box.y];
    group = group.map((a) => translate(a, dx, dy));
  }
  commit(id, [...getItems(id), ...group]);
  useMarkup.getState().select(id, group.map((a) => a.id));
}

/** Cola as anotações copiadas, se ainda forem a última cópia do sistema; `false` = não há. */
export async function pasteAnnotations(): Promise<boolean> {
  const data = await ipc.pastedAnnotations().catch(() => null);
  const doc = activeDoc();
  const items = data ? deserialize(data).items : [];
  if (!items.length || !viewable(doc)) return false;
  useSelection.getState().setSelection(null);
  const mk = useMarkup.getState();
  mk.setVisible(true);
  mk.setTool("select");
  insert(doc.id, items);
  return true;
}

export const duplicateAnnotations = (id: DocId) => insert(id, selectedItems(id));

/** Todas as anotações da página mostrada. */
export const selectAllAnnotations = (id: DocId) => useMarkup.getState().select(id, pageItems(id).map((a) => a.id));
