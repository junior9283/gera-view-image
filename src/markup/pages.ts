// Páginas de um documento (TIFF): cada anotação pertence à página em que foi feita. Numa animação
// (GIF/WebP) não há páginas: a anotação vale para todos os quadros.
import type { DocId, DocInfo } from "../ipc/types";
import { useDocs } from "../store/docs";
import { useUi } from "../store/ui";
import type { Annotation } from "./model";
import { getItems } from "./store";

export const docOf = (id: DocId) => useDocs.getState().docs.find((d) => d.id === id);

/** Várias páginas, pelo critério do Rust (`page_sizes`): quem tem atrasos é animação. */
export const hasPages = (d: DocInfo | null | undefined): boolean => !!d && d.frames > 1 && !d.delaysMs?.length;

/** Página mostrada de `id` (a primeira, se ele não é o documento ativo). */
export const shownPage = (id: DocId): number =>
  useDocs.getState().activeId === id ? (useUi.getState().page ?? 0) : 0;

/** Anotações de `items` que estão na página `page` de `doc`. */
export const onPage = (items: Annotation[], doc: DocInfo | null | undefined, page: number | null): Annotation[] =>
  hasPages(doc) ? items.filter((a) => (a.page ?? 0) === (page ?? 0)) : items;

/** Anotações da página mostrada. */
export const pageItems = (id: DocId): Annotation[] => onPage(getItems(id), docOf(id), useUi.getState().page);

/** Gravar só a página `page` de `id` deixa anotações de fora. */
export const leavesOut = (id: DocId, page: number): boolean =>
  onPage(getItems(id), docOf(id), page).length < getItems(id).length;

/** A anotação nova `a` na página mostrada. */
export function onCurrentPage<A extends Annotation>(id: DocId, a: A): A {
  const page = useUi.getState().page;
  return page && hasPages(docOf(id)) ? { ...a, page } : a;
}
