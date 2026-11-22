// Páginas de um `DocInfo` (TIFF): cada uma tem o próprio tamanho. Só contas, sem estado.
import type { DocInfo } from "../ipc/types";

/** Várias páginas, pelo critério do Rust (`page_sizes`): quem tem atrasos é animação. */
export const hasPages = (d: DocInfo | null | undefined): boolean => !!d && d.frames > 1 && !d.delaysMs?.length;

/** Tamanho da página `page` (nulo = a primeira); sem páginas, o da imagem. */
export function pageSize(d: DocInfo, page: number | null): { w: number; h: number } {
  const size = hasPages(d) ? d.pageSizes?.[page ?? 0] : undefined;
  return size ? { w: size[0], h: size[1] } : { w: d.width, h: d.height };
}
