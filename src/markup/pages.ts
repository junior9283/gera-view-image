// Páginas de um documento (TIFF): cada anotação pertence à página em que foi feita. Numa animação
// (GIF/WebP) não há páginas: a anotação vale para todos os quadros.
import type { DocId, DocInfo } from "../ipc/types";
import { useDocs } from "../store/docs";
import { useUi } from "../store/ui";
import { isAnimated } from "../viewer/paint";
import type { Annotation } from "./model";
import { getItems } from "./store";

export const docOf = (id: DocId) => useDocs.getState().docs.find((d) => d.id === id);

export const hasPages = (d: DocInfo | null | undefined): boolean => !!d && d.frames > 1 && !isAnimated(d);

/** Anotações de `items` que estão na página `page` de `doc`. */
export const onPage = (items: Annotation[], doc: DocInfo | null | undefined, page: number | null): Annotation[] =>
  hasPages(doc) ? items.filter((a) => (a.page ?? 0) === (page ?? 0)) : items;

/** Anotações da página mostrada. */
export const pageItems = (id: DocId): Annotation[] => onPage(getItems(id), docOf(id), useUi.getState().page);

/** A anotação nova `a` na página mostrada. */
export function onCurrentPage<A extends Annotation>(id: DocId, a: A): A {
  const page = useUi.getState().page;
  return page && hasPages(docOf(id)) ? { ...a, page } : a;
}
